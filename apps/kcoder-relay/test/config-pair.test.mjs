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
import { buildPairingLink, fetchGatewayPairing } from '../src/pair.mjs';
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

test('pairing discovery accepts a fixed mobile credential and enforces an explicitly selected mode', async () => {
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
      publicGateway, tokenMode, fetchImpl: pairingFetch(publicGateway, override) }), /invalid mobile pairing/);
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

async function privateTempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-relay-config-pair-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function isolatedPairingModule(directory) {
  const runtimeRoot = join(directory, 'pairing-runtime');
  const sourceDirectory = join(runtimeRoot, 'apps', 'kcoder-relay', 'src');
  const sharedDirectory = join(runtimeRoot, 'apps', 'kcoder-studio', 'shared');
  await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
  await mkdir(sharedDirectory, { recursive: true, mode: 0o700 });
  for (const name of ['pair.mjs', 'config.mjs', 'admin-auth.mjs', 'client-identity.mjs', 'connection-routes.mjs', 'gateway-origin.mjs']) {
    await copyFile(join(relayPackageRoot, 'src', name), join(sourceDirectory, name));
  }
  await copyFile(
    join(relayPackageRoot, '../kcoder-studio/shared/gatewayConnectionRoutes.js'),
    join(sharedDirectory, 'gatewayConnectionRoutes.js'),
  );

  let nodeModulesDirectory = dirname(fileURLToPath(import.meta.resolve('qrcode')));
  while (basename(nodeModulesDirectory) !== 'node_modules' && dirname(nodeModulesDirectory) !== nodeModulesDirectory) {
    nodeModulesDirectory = dirname(nodeModulesDirectory);
  }
  if (basename(nodeModulesDirectory) !== 'node_modules') {
    throw new Error('Unable to locate the Relay test node_modules directory');
  }
  await symlink(
    nodeModulesDirectory,
    join(runtimeRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const clientIdentity = await import(pathToFileURL(join(sourceDirectory, 'client-identity.mjs')).href);
  const isolatedIdentityFile = join(runtimeRoot, 'target', 'kcoder-relay', 'client-identity.json');
  assert.equal(clientIdentity.DEFAULT_IDENTITY_FILE, isolatedIdentityFile);
  await assert.rejects(stat(isolatedIdentityFile), { code: 'ENOENT' });
  return import(pathToFileURL(join(sourceDirectory, 'pair.mjs')).href);
}

async function writeRegistry(t, value, { mode = 0o600 } = {}) {
  const directory = await privateTempDir(t);
  const path = join(directory, 'registry.json');
  await writeFile(path, Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value), { mode });
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

test('registry rejects malformed JSON, unknown fields, missing fields, and non-private files', async t => {
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

  const publicPath = await writeRegistry(t, registry(), { mode: 0o644 });
  await chmod(publicPath, 0o644);
  if (process.platform !== 'win32') assert.throws(() => configFor(publicPath), /must be private/);
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

test('pairing link routes multi-Gateway codes through /g/id and keeps legacy URLs stable', () => {
  const multi = new URL(buildPairingLink({
    publicUrl: 'https://hyf2333.top:8451',
    token: tokenA,
    gatewayId: 'cyx',
  }));
  assert.equal(multi.protocol, 'kcoder-studio:');
  assert.equal(multi.host, 'connect');
  assert.equal(multi.searchParams.get('gateway'), cyxGateway);
  assert.match(new URL(cyxGateway).hostname, /^g-[a-f0-9]{40}\.hyf2333\.top$/);
  assert.equal(multi.searchParams.get('gatewayId'), 'cyx');
  assert.equal(multi.searchParams.get('token'), tokenA);
  assert.equal(multi.toString().includes(secretA), false);

  const legacy = new URL(buildPairingLink({ publicUrl: 'https://hyf2333.top:8451', token: tokenA }));
  assert.equal(legacy.searchParams.get('gateway'), 'https://hyf2333.top:8451');
  assert.equal(legacy.searchParams.get('gatewayId'), null);
  assert.throws(() => buildPairingLink({
    publicUrl: 'https://hyf2333.top:8451', token: tokenA, gatewayId: 'cyx', routeMode: 'host',
  }), /Unsupported relay route mode/);
});

test('pairing link embeds only validated nonsecret connection routes and checks the paired public endpoint', () => {
  const input = { publicUrl: 'https://relay.example:8451', token: tokenA, gatewayId: 'cyx', routeMode: 'path' };
  const connectionRoutes = {
    version: 1,
    gatewayId: 'a'.repeat(64),
    publicKey: 'b'.repeat(64),
    endpoints: [
      { kind: 'public', url: isolated('https://relay.example:8451', 'cyx') },
    ],
  };
  const native = new URL(buildPairingLink({ ...input, connectionRoutes }));
  assert.deepEqual(JSON.parse(native.searchParams.get('routes')), connectionRoutes);
  assert.equal(native.searchParams.get('gateway'), isolated('https://relay.example:8451', 'cyx'));
  assert.equal(native.searchParams.get('token'), tokenA);
  assert.equal(native.searchParams.get('routes').includes(tokenA), false);

  const web = new URL(buildPairingLink({ ...input, client: 'web', connectionRoutes }));
  assert.equal(web.searchParams.has('token'), false);
  assert.deepEqual(JSON.parse(web.searchParams.get('routes')), connectionRoutes);
  assert.equal(new URLSearchParams(web.hash.slice(1)).get('token'), tokenA, 'Mobile Web keeps its credential in the fragment');

  assert.throws(() => buildPairingLink({ ...input, connectionRoutes: { ...connectionRoutes, gatewayId: 'invalid' } }), /invalid connection routes/);
  assert.throws(() => buildPairingLink({ ...input, connectionRoutes: {
    ...connectionRoutes,
    endpoints: [
      { kind: 'public', url: isolated('https://relay.example:8451', 'other') },
    ],
  } }), /do not contain the paired public Gateway URL/);
  assert.throws(() => buildPairingLink({ ...input, connectionRoutes: {
    ...connectionRoutes,
    endpoints: [{ kind: 'public', url: 'https://relay.example:8451/g/cyx' }],
  } }), /do not contain the paired public Gateway URL/, 'the old shared-origin endpoint is not the paired Gateway');

  assert.throws(() => buildPairingLink({ ...input, token: 'x'.repeat(8192) }), /8192-character limit/);
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

test('pair module imports without reading configuration or writing a QR', async () => {
  const importPath = `../src/pair.mjs?side-effect-check=${Date.now()}`;
  const module = await import(importPath);
  assert.equal(typeof module.buildPairingLink, 'function');
  assert.equal(typeof module.writePairingQr, 'function');
});

test('pair CLI helper writes a private QR for the selected Gateway token', async t => {
  const directory = await privateTempDir(t);
  const registryPath = await writeRegistry(t, registry());
  const output = join(directory, 'pairing.png');
  const { writePairingQr: writePairingQrInIsolatedRuntime } = await isolatedPairingModule(directory);
  const written = await writePairingQrInIsolatedRuntime({
    output, fetchImpl: pairingFetch(cyxGateway),
    env: {
      KCODER_RELAY_REGISTRY_FILE: registryPath,
      KCODER_RELAY_PUBLIC_URL: 'https://hyf2333.top:8451',
    },
  });
  const info = await stat(written);
  assert.equal(info.mode & 0o777, 0o600);
  assert.ok((await readFile(written)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
});

test('pair CLI gets dynamic pairing credentials through its private loopback endpoint without creating a session', async t => {
  const directory = await privateTempDir(t);
  const registryPath = await writeRegistry(t, registry());
  const requests = [];
  const entries = [];
  const { writePairingQr: pair } = await isolatedPairingModule(directory);
  const fetchPairing = pairingFetch(cyxGateway);
  const output = join(directory, 'dynamic.png');
  await pair({ output, env: { KCODER_RELAY_REGISTRY_FILE: registryPath,
    KCODER_RELAY_PUBLIC_URL: 'https://hyf2333.top:8451', KCODER_RELAY_LOCAL_GATEWAY: 'http://127.0.0.1:4186' },
    fetchImpl: (url, options) => { requests.push(url.toString()); return fetchPairing(url, options); },
    onMobileEntry: value => entries.push(value) });
  assert.equal(requests.length, 1, 'no mobile session is allocated for QR generation');
  assert.deepEqual(entries, [`${cyxGateway}/mobile/`]);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test('pair CLI fails closed for invalid dynamic credentials, wrong public identity and unsafe discovery URLs', async t => {
  const directory = await privateTempDir(t);
  const registryPath = await writeRegistry(t, registry());
  const { writePairingQr: pair } = await isolatedPairingModule(directory);
  for (const override of [{ token: tokenA }, { expiresAt: 0 }, { publicBaseUrl: 'https://other.example' },
    { connectionRoutes: { version: 1, gatewayId: 'invalid', endpoints: [] } }]) {
    const output = join(directory, 'must-not-exist.png');
    await assert.rejects(pair({ output, env: { KCODER_RELAY_REGISTRY_FILE: registryPath, KCODER_RELAY_PUBLIC_URL: 'https://hyf2333.top:8451' },
      fetchImpl: pairingFetch(cyxGateway, override) }), error => {
      assert.match(error.message, /invalid (mobile pairing credentials|connection routes)/);
      assert.ok(!error.message.includes(tokenA) && !error.message.includes(dynamicToken)); return true;
    });
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
  await assert.rejects(pair({ env: { KCODER_RELAY_REGISTRY_FILE: registryPath,
    KCODER_RELAY_PUBLIC_URL: 'https://hyf2333.top:8451', KCODER_RELAY_LOCAL_GATEWAY: 'https://remote.example' } }), /loopback HTTP/);
});

test('registry pairing rejects every route-mode override except path', async t => {
  const registryPath = await writeRegistry(t, registry());
  for (const routeMode of ['legacy', 'host', '']) {
    await t.test(`rejects route mode ${JSON.stringify(routeMode)}`, async t2 => {
      const directory = await privateTempDir(t2);
      const output = join(directory, `pairing-${routeMode || 'empty'}.png`);
      const { writePairingQr: writePairingQrInIsolatedRuntime } = await isolatedPairingModule(directory);
      await assert.rejects(() => writePairingQrInIsolatedRuntime({
        output,
        env: {
          KCODER_RELAY_REGISTRY_FILE: registryPath,
          KCODER_RELAY_PUBLIC_URL: 'https://hyf2333.top:8451',
          KCODER_RELAY_ROUTE_MODE: routeMode,
        },
      }), /Registry mode requires path-based Gateway routing/);
      await assert.rejects(() => stat(output), { code: 'ENOENT' });
    });
  }
});

test('legacy single-Gateway environment can explicitly use path routing', async t => {
  const directory = await privateTempDir(t);
  const output = join(directory, 'legacy-path.png');
  const { writePairingQr: writePairingQrInIsolatedRuntime } = await isolatedPairingModule(directory);
  const written = await writePairingQrInIsolatedRuntime({
    output, fetchImpl: pairingFetch(cyxGateway),
    env: {
      KCODER_RELAY_SECRET: secretA,
      KCODER_RELAY_DEVICE_ID: 'cyx',
      KCODER_RELAY_GATEWAY_SECRET: tokenA,
      KCODER_RELAY_PUBLIC_URL: 'https://hyf2333.top:8451',
      KCODER_RELAY_ROUTE_MODE: 'path',
    },
  });
  assert.equal(written, output);
  assert.equal((await stat(written)).mode & 0o777, 0o600);
});

test('web pairing uses the same Gateway route with fragment credentials and keeps native links compatible', () => {
  const input = { publicUrl: 'https://relay.example', token: tokenA, gatewayId: 'auto-assigned-id', routeMode: 'path' };
  const web = new URL(buildPairingLink({ ...input, client: 'web' }));
  assert.equal(web.pathname, '/g/auto-assigned-id/mobile/connect');
  assert.equal(web.origin, new URL(isolated('https://relay.example', 'auto-assigned-id')).origin, 'Mobile Web opens on the Gateway origin');
  assert.equal(web.searchParams.get('gateway'), isolated('https://relay.example', 'auto-assigned-id'));
  assert.equal(web.searchParams.has('token'), false);
  assert.equal(new URLSearchParams(web.hash.slice(1)).get('token'), tokenA);
  assert.equal(web.searchParams.get('gatewayId'), 'auto-assigned-id');
  const native = new URL(buildPairingLink(input));
  assert.equal(native.protocol, 'kcoder-studio:');
  assert.equal(native.searchParams.get('token'), tokenA);
  assert.equal(native.hash, '');
  assert.throws(() => buildPairingLink({ ...input, client: 'unsupported' }), /Unsupported pairing client/);
});

test('registered pairing prints only the actual auto-assigned Gateway Mobile Web entry', async t => {
  const directory = await privateTempDir(t);
  const identityFile = join(directory, 'identity.json');
  await writeFile(identityFile, JSON.stringify({ version: 1, relayOrigin: 'https://relay.example',
    gatewaySecretHash: createHash('sha256').update(tokenA).digest('hex'), id: 'registered-id', secret: secretA,
  }), { mode: 0o600 });
  const entries = [];
  const { writePairingQr: writePairingQrInIsolatedRuntime } = await isolatedPairingModule(directory);
  const destination = await writePairingQrInIsolatedRuntime({ fetchImpl: pairingFetch(isolated('https://relay.example', 'registered-id')), env: {
    KCODER_RELAY_IDENTITY_FILE: identityFile, KCODER_RELAY_PUBLIC_URL: 'https://relay.example',
    KCODER_RELAY_GATEWAY_SECRET: tokenA, KCODER_RELAY_PAIR_CLIENT: 'web',
  }, output: join(directory, 'pair.png'), onMobileEntry: value => entries.push(value) });
  assert.deepEqual(entries, [`${isolated('https://relay.example', 'registered-id')}/mobile/`]);
  assert.ok(!entries[0].includes(tokenA) && !entries[0].includes(secretA));
  assert.ok((await stat(destination)).size > 0);
});
