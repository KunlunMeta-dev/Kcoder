import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseGatewayConnectionRoutes } from '../../shared/gatewayConnectionRoutes.js';

const RUN_ROOT_PATTERN = /^\/tmp\/kcoder-e2e-peer-route-\d{14}-[a-f0-9]{12}-(?:lan|public)$/;
const FIXTURE_BYTES = 1024 * 1024;
const FIXTURE_CHUNK_BYTES = 512 * 1024;
const FIXTURE_PATH = '/peer-route/fixture-payload-1m.bin';
const PUBLIC_RELAY_ORIGIN = 'https://hyf2333.top:8451';
const PUBLIC_STUN_URL = 'stun:47.80.92.250:8452';
const gatewayDeviceBaselines = new WeakMap();

export async function readRemoteOwnerConfig(root) {
  assertRunRootPath(root);
  await verifyOwnedDirectory(root, 'remote root', 0o700);
  const privateDirectory = join(root, 'private');
  await verifyOwnedDirectory(privateDirectory, 'remote private directory', 0o700);
  const path = join(privateDirectory, 'owner-config.json');
  await verifyRegularOwnedFile(path, 'remote owner config', 64 * 1024, 0o600);

  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('remote owner config is not valid JSON'); }
  const runId = root.match(/^\/tmp\/kcoder-e2e-(peer-route-\d{14}-[a-f0-9]{12})-(?:lan|public)$/)?.[1];
  if (!isRecord(config) || config.schemaVersion !== 1 || !['lan', 'public'].includes(config.role) ||
      config.root !== root || typeof runId !== 'string' || config.runId !== runId ||
      !validRootReceipt(config.rootReceipt, root, runId, config.role) ||
      !/^[A-Za-z0-9._~-]{32,512}$/.test(config.gatewayAuthToken || '') ||
      !/^[a-f0-9]{64}$/.test(config.packageTreeSha256 || '') ||
      !/^[a-f0-9]{64}$/.test(config.mobileWebBundleSha256 || '') ||
      !/^[a-f0-9]{24}$/.test(config.workspaceId || '') || config.serverId !== 'peer-route-fixture' ||
      !isRecord(config.fixture) || !/^[a-f0-9]{32}$/.test(config.fixture.threadId || '') ||
      config.fixture.attachmentPath !== FIXTURE_PATH || config.fixture.payloadFile !== 'fixture-payload-1m.bin' ||
      config.fixture.size !== FIXTURE_BYTES || !/^[a-f0-9]{64}$/.test(config.fixture.payloadSha256 || '') ||
      config.fixture.chunkBytes !== FIXTURE_CHUNK_BYTES) {
    throw new Error('remote owner config fields or synthetic fixture metadata are invalid');
  }

  if (config.role === 'lan') {
    if (config.publicOrigin !== undefined || config.registrationKey !== undefined ||
        !/^lan-[a-f0-9]{16}$/.test(config.gatewayId || '')) {
      throw new Error('LAN remote owner config fields are invalid');
    }
  } else if (config.publicOrigin !== PUBLIC_RELAY_ORIGIN || config.stunUrl !== PUBLIC_STUN_URL ||
      !/^[A-Za-z0-9._~-]{32,512}$/.test(config.registrationKey || '') || config.gatewayId !== undefined) {
    throw new Error('public remote owner Relay config fields are invalid');
  }

  const manifestPath = join(root, 'package', 'package-manifest.json');
  await verifyRegularOwnedFile(manifestPath, 'portable package manifest', 8 * 1024 * 1024);
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { throw new Error('portable package manifest is not valid JSON'); }
  const manifestFixture = manifest?.appServerFixture;
  if (!isRecord(manifest) || manifest.schemaVersion !== 1 || manifest.packageTreeSha256 !== config.packageTreeSha256 ||
      manifest.mobileWeb?.sourceBundleSha256 !== config.mobileWebBundleSha256 ||
      manifestFixture?.attachmentPath !== config.fixture.attachmentPath ||
      manifestFixture?.payloadFile !== config.fixture.payloadFile ||
      manifestFixture?.payloadBytes !== config.fixture.size ||
      manifestFixture?.payloadSha256 !== config.fixture.payloadSha256 ||
      manifestFixture?.chunkBytes !== config.fixture.chunkBytes) {
    throw new Error('remote owner config does not match its staged package and fixture manifest');
  }
  return config;
}

export async function verifyRemoteRoot(root, expected) {
  assertRunRootPath(root);
  const info = await verifyOwnedDirectory(root, 'remote root', 0o700);
  const runId = root.match(/^\/tmp\/kcoder-e2e-(peer-route-\d{14}-[a-f0-9]{12})-(?:lan|public)$/)?.[1];
  const role = root.endsWith('-lan') ? 'lan' : 'public';
  const actual = {
    root,
    runId,
    role,
    uid: String(info.uid),
    dev: String(info.dev),
    ino: String(info.ino),
  };
  if (!validRootReceipt(expected, root, runId, role) || expected.uid.toString() !== actual.uid ||
      expected.dev.toString() !== actual.dev || expected.ino.toString() !== actual.ino) {
    throw new Error('remote root receipt does not match the owned directory identity');
  }
  return actual;
}

export async function writeJson0600(path, value) {
  const absolutePath = resolve(path);
  const parent = dirname(absolutePath);
  await verifyOwnedDirectory(parent, 'private JSON parent', 0o700);
  const handle = await open(absolutePath, 'wx', 0o600);
  const created = await handle.stat();
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    const current = await lstat(absolutePath).catch(() => null);
    if (current && current.dev === created.dev && current.ino === created.ino && current.isFile() && !current.isSymbolicLink()) {
      await unlink(absolutePath).catch(() => {});
    }
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
  const info = await verifyRegularOwnedFile(absolutePath, 'private JSON file', undefined, 0o600);
  await syncDirectory(parent);
  return { path: absolutePath, dev: String(info.dev), ino: String(info.ino) };
}

export async function getAdminPairing(context, gateway, authToken) {
  requireContext(context);
  // During owner cleanup the RunContext is already finishing. The auth token
  // was registered when the run started; values fetched here are used only in
  // the bounded cleanup requests and must not be added to the finished log.
  const registerSecret = value => { if (!context.finishing) context.registerSecret(value); };
  registerSecret(authToken);
  assertFreshGateway(context, gateway);

  const loginUrl = new URL('/login', gateway.baseUrl);
  loginUrl.searchParams.set('token', authToken);
  loginUrl.searchParams.set('returnTo', '/');
  const login = await fetch(loginUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  if (login.status !== 303) throw new Error('fresh Gateway admin login did not issue a bounded session');
  const rawCookie = login.headers.get('set-cookie') || '';
  const cookie = rawCookie.split(';', 1)[0];
  const sessionValue = cookie.startsWith('kcoder_studio_session=')
    ? cookie.slice('kcoder_studio_session='.length)
    : '';
  if (sessionValue) registerSecret(sessionValue);
  if (!/^kcoder_studio_session=[A-Za-z0-9_-]{32,128}$/.test(cookie)) {
    throw new Error('fresh Gateway admin session cookie is invalid');
  }

  const response = await fetch(new URL('/api/mobile/pairing', gateway.baseUrl), {
    cache: 'no-store',
    headers: { cookie },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) throw new Error('authenticated fresh Gateway pairing endpoint is unavailable');
  let body;
  try { body = await response.json(); }
  catch { throw new Error('fresh Gateway pairing endpoint returned invalid JSON'); }
  const pairingToken = body?.token;
  if (typeof pairingToken === 'string') registerSecret(pairingToken);
  if (typeof pairingToken !== 'string' || !/^[A-Za-z0-9._~-]{32,512}$/.test(pairingToken)) {
    throw new Error('fresh Gateway pairing endpoint returned no valid run-scoped token');
  }
  if (!Array.isArray(body.devices) || body.devices.some(device => !device || typeof device !== 'object')) {
    throw new Error('fresh Gateway pairing endpoint returned no device inventory');
  }
  const connectionRoutes = parseGatewayConnectionRoutes(body.connectionRoutes);
  if (!connectionRoutes) throw new Error('fresh Gateway pairing endpoint returned no valid signed route descriptor');
  registerSecret(JSON.stringify(connectionRoutes));

  let perGateway = gatewayDeviceBaselines.get(context);
  if (!perGateway) {
    perGateway = new Map();
    gatewayDeviceBaselines.set(context, perGateway);
  }
  const latestDevices = body.devices.filter(device => typeof device.id === 'string');
  const currentIds = new Set(latestDevices.map(device => device.id));
  const previous = perGateway.get(gateway.baseUrl);
  if (previous) {
    previous.latestDeviceIds = currentIds;
  } else {
    perGateway.set(gateway.baseUrl, { initialDeviceIds: currentIds, latestDeviceIds: currentIds });
  }

  return { pairing: { token: pairingToken, expiresAt: body.expiresAt }, connectionRoutes, cookie };
}

export async function verifyMobileStaticReady(gateway) {
  assertLoopbackGatewayAddress(gateway);
  const response = await fetch(new URL('/mobile/', gateway.baseUrl), {
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200 || !/text\/html/i.test(response.headers.get('content-type') || '')) {
    throw new Error('fresh Gateway Mobile static index did not return an HTML 200 response');
  }
  const body = await response.text();
  if (body.length < 256 || !/<html|<!doctype/i.test(body)) {
    throw new Error('fresh Gateway Mobile static index is missing or incomplete');
  }
  return { status: response.status, contentType: response.headers.get('content-type'), bytes: Buffer.byteLength(body) };
}

export async function revokeBenchmarkDevices(context, gateway, authToken) {
  requireContext(context);
  assertFreshGateway(context, gateway);
  let perGateway = gatewayDeviceBaselines.get(context);
  const baseline = perGateway?.get(gateway.baseUrl);
  if (!baseline) {
    await getAdminPairing(context, gateway, authToken);
    perGateway = gatewayDeviceBaselines.get(context);
  }
  const current = await getAdminPairing(context, gateway, authToken);
  const inventory = gatewayDeviceBaselines.get(context)?.get(gateway.baseUrl);
  if (!inventory) throw new Error('fresh Gateway device ownership baseline was not established');
  for (const id of inventory.latestDeviceIds) {
    if (inventory.initialDeviceIds.has(id) || !/^[A-Za-z0-9-]{16,128}$/.test(id)) continue;
    // This revokes only new device IDs on the owned loopback Gateway; no Relay endpoint is contacted.
    const deletion = await fetch(new URL(`/api/mobile/pairing/devices/${encodeURIComponent(id)}`, gateway.baseUrl), {
      method: 'DELETE',
      headers: {
        cookie: current.cookie,
        origin: new URL(gateway.baseUrl).origin,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    if (deletion.status !== 204) throw new Error('fresh Gateway benchmark-device revocation did not complete');
  }
}

export async function createReadyReceipt({ root, rootInfo, config, gateway, gatewayOrigin, tlsOrigin, pairing, routes,
  caMaterial, publicOrigin, relayGatewayId, stagedManifest, context }) {
  requireContext(context);
  if (typeof pairing?.token === 'string') context.registerSecret(pairing.token);
  assertFreshGateway(context, gateway);
  if (!isRecord(config) || !['lan', 'public'].includes(config.role) || !isRecord(rootInfo) ||
      rootInfo.root !== root || rootInfo.runId !== config.runId || rootInfo.role !== config.role ||
      !isRecord(pairing) || typeof pairing.token !== 'string' || !parseGatewayConnectionRoutes(routes)) {
    throw new Error('fresh Gateway ready receipt inputs are invalid');
  }
  const normalizedRoutes = parseGatewayConnectionRoutes(routes);
  const routeBase = config.role === 'public' ? `${publicOrigin}/g/${relayGatewayId}` : tlsOrigin;
  const expectedRouteBase = config.role === 'public' ? `${PUBLIC_RELAY_ORIGIN}/g/${relayGatewayId}` : tlsOrigin;
  if (typeof routeBase !== 'string' || routeBase !== expectedRouteBase ||
      !normalizedRoutes.endpoints.some(endpoint => endpoint.url === routeBase) ||
      config.role === 'public' && !/^[A-Za-z0-9_-]{1,64}$/.test(relayGatewayId || '') ||
      config.role === 'lan' && (!/^https:\/\/10\.31\.6\.5:\d+$/.test(tlsOrigin || '') || gatewayOrigin !== tlsOrigin) ||
      config.role === 'public' && (gatewayOrigin !== PUBLIC_RELAY_ORIGIN || publicOrigin !== PUBLIC_RELAY_ORIGIN)) {
    throw new Error('fresh Gateway signed route descriptor does not advertise the owned lane origin');
  }

  const lane = {
    mobileConnectUrl: `${routeBase}/mobile/connect`,
    publicBaseUrl: routeBase,
    pairingToken: pairing.token,
    connectionRoutes: normalizedRoutes,
    expectedGatewayIps: config.role === 'public' ? ['107.173.236.155'] : ['10.31.6.5'],
    expectedClientIps: config.role === 'public' ? ['10.31.6.23', '175.0.133.87'] : ['10.31.6.8'],
    ...(config.role === 'public' ? { stunUrl: config.stunUrl } : {}),
  };
  const caTrust = caMaterial ? await readPublicCaTrust(context, caMaterial) : null;
  if ((config.role === 'lan') !== Boolean(caTrust)) throw new Error('LAN/public Gateway CA receipt shape is invalid');
  const safe = {
    status: 'ready',
    role: config.role,
    root,
    rootDev: rootInfo.dev,
    rootIno: rootInfo.ino,
    gatewayPort: gateway.port,
    gatewayBaseUrl: gateway.baseUrl,
    publicBaseUrl: routeBase,
    gatewayRouteId: config.role === 'public' ? relayGatewayId : null,
    publicP2PEnabled: config.role === 'public',
    stunUrl: config.role === 'public' ? config.stunUrl : null,
    packageTreeSha256: config.packageTreeSha256,
    mobileWebBundleSha256: config.mobileWebBundleSha256,
    sourceGitHead: stagedManifest?.gitHead ?? null,
    gatewayPid: gateway.child.pid,
  };
  return { safe, lane, caTrust, mobileStatic: await verifyMobileStaticReady(gateway) };
}

export async function writeRemoteOwnerReceipt(root, receipt, context) {
  requireContext(context);
  if (typeof receipt?.lane?.pairingToken === 'string') context.registerSecret(receipt.lane.pairingToken);
  if (!isRecord(receipt) || !isRecord(receipt.safe) || !isRecord(receipt.lane) ||
      typeof receipt.lane.pairingToken !== 'string' || !isRecord(receipt.lane.connectionRoutes) ||
      !receipt.safe || receipt.safe.status !== 'ready' || receipt.safe.root !== root ||
      (receipt.caTrust !== null && receipt.caTrust !== undefined &&
        (typeof receipt.caTrust.certificatePem !== 'string' || /PRIVATE KEY/.test(receipt.caTrust.certificatePem))) ||
      Object.keys(receipt.safe).some(key => /token|cookie|secret|credential|privatekey/i.test(key)) ||
      JSON.stringify(receipt.safe).includes(receipt.lane.pairingToken) ||
      JSON.stringify(receipt).includes('PRIVATE KEY')) {
    throw new Error('private remote owner receipt has an invalid or secret-bearing shape');
  }
  assertRunRootPath(root);
  await verifyOwnedDirectory(root, 'remote root', 0o700);
  const privateDirectory = join(root, 'private');
  await verifyOwnedDirectory(privateDirectory, 'remote private directory', 0o700);
  const path = join(privateDirectory, 'ready.json');
  const written = await writeJson0600(path, receipt);
  context.addCleanup('remove remote private ready receipt', async () => {
    const info = await verifyRegularOwnedFile(path, 'private ready receipt', undefined, 0o600);
    if (String(info.dev) !== written.dev || String(info.ino) !== written.ino) {
      throw new Error('remote private receipt identity changed; refusing to remove it');
    }
    await unlink(path);
  });
}

export async function existsRegularFile(path) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function writeRemoteOwnerStatus(root, status, context, ownerLease) {
  requireContext(context);
  if (!['failed', 'stopped'].includes(status)) throw new Error('remote owner status is invalid');
  assertRunRootPath(root);
  await verifyOwnedDirectory(root, 'remote root', 0o700);
  const privateDirectory = join(root, 'private');
  await verifyOwnedDirectory(privateDirectory, 'remote private directory', 0o700);
  const runId = root.match(/^\/tmp\/kcoder-e2e-(peer-route-\d{14}-[a-f0-9]{12})-(?:lan|public)$/)?.[1];
  const role = root.endsWith('-lan') ? 'lan' : 'public';
  const ownerPath = join(privateDirectory, 'owner-running.json');
  await verifyRegularOwnedFile(ownerPath, 'remote owner identity', 16 * 1024, 0o600);
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  const rootInfo = await verifyOwnedDirectory(root, 'remote root', 0o700);
  if (!isRecord(ownerLease) || ownerLease.schemaVersion !== 1 || ownerLease.runId !== runId ||
      ownerLease.role !== role || ownerLease.root !== root || ownerLease.rootDev !== String(rootInfo.dev) ||
      ownerLease.rootIno !== String(rootInfo.ino) || !isRecord(ownerLease.process) ||
      !isRecord(owner) || owner.schemaVersion !== 1 || owner.runId !== runId || owner.role !== role ||
      owner.root !== root || owner.rootDev !== String(rootInfo.dev) || owner.rootIno !== String(rootInfo.ino) ||
      !isRecord(owner.process) || !Number.isSafeInteger(owner.process.pid) || owner.process.pid <= 1 ||
      owner.process.pgid !== owner.process.pid || owner.process.sid !== owner.process.pid ||
      !Number.isSafeInteger(owner.process.startTicks) || owner.process.startTicks <= 0 ||
      JSON.stringify(owner.process) !== JSON.stringify(ownerLease.process)) {
    throw new Error('remote owner identity receipt is invalid');
  }
  const processGroups = [...new Set([...context.processes.values()]
    .map(record => record.pgid)
    .filter(pgid => Number.isSafeInteger(pgid) && pgid > 1))]
    .sort((left, right) => left - right)
    .map(pgid => ({ pgid, alive: isProcessGroupAlive(pgid) }));
  const path = join(privateDirectory, 'owner-status.json');
  const value = {
    schemaVersion: 1,
    status,
    at: new Date().toISOString(),
    runId,
    role,
    root,
    rootDev: String(rootInfo.dev),
    rootIno: String(rootInfo.ino),
    owner: ownerLease.process,
    contextRunRoot: context.runRoot,
    ownedProcessGroups: processGroups,
    allOwnedProcessGroupsGone: processGroups.every(group => !group.alive),
  };
  let prior;
  try {
    prior = await verifyRegularOwnedFile(path, 'remote owner status', 64 * 1024, 0o600);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeJson0600(path, value);
    return;
  }
  const temporary = join(privateDirectory, `.owner-status-${randomBytes(8).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    const current = await verifyRegularOwnedFile(path, 'remote owner status', 64 * 1024, 0o600);
    if (current.dev !== prior.dev || current.ino !== prior.ino) {
      throw new Error('remote owner status identity changed during update');
    }
    await rename(temporary, path);
    await syncDirectory(privateDirectory);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function isProcessGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function readPublicCaTrust(context, caMaterial) {
  if (typeof caMaterial.caCertificatePath !== 'string' ||
      !/^[a-f0-9]{64}$/.test(caMaterial.caCertificateSha256 || '') ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(caMaterial.nickname || '')) {
    throw new Error('run-owned public CA receipt metadata is invalid');
  }
  const path = resolve(caMaterial.caCertificatePath);
  const stateRoot = resolve(context.stateDir);
  if (path === stateRoot || !path.startsWith(`${stateRoot}/`)) {
    throw new Error('public CA certificate must be stored inside the RunContext state');
  }
  const info = await verifyRegularOwnedFile(path, 'run-owned public CA certificate', 128 * 1024, 0o600);
  void info;
  const bytes = await readFile(path);
  const pem = bytes.toString('utf8');
  if (!pem.startsWith('-----BEGIN CERTIFICATE-----\n') || !pem.includes('-----END CERTIFICATE-----') ||
      createHash('sha256').update(bytes).digest('hex') !== caMaterial.caCertificateSha256) {
    throw new Error('run-owned public CA certificate hash or PEM shape is invalid');
  }
  return { certificatePem: pem, certificateSha256: caMaterial.caCertificateSha256, nickname: caMaterial.nickname };
}

function assertFreshGateway(context, gateway) {
  if (!gateway || typeof gateway.baseUrl !== 'string' || !gateway.child || !Number.isInteger(gateway.port)) {
    throw new Error('a live RunContext-owned Gateway is required');
  }
  const url = new URL(gateway.baseUrl);
  if (!isLoopbackGatewayUrl(url) || Number(url.port) !== gateway.port ||
      ![...context.processes.values()].some(record => record.child === gateway.child)) {
    throw new Error('Gateway admin operations are restricted to the fresh RunContext-owned loopback Gateway');
  }
}

function assertLoopbackGatewayAddress(gateway) {
  if (!gateway || typeof gateway.baseUrl !== 'string') throw new Error('fresh Gateway base URL is required');
  if (!isLoopbackGatewayUrl(new URL(gateway.baseUrl))) throw new Error('Mobile static probe is restricted to the loopback Gateway');
}

function isLoopbackGatewayUrl(url) {
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) &&
    url.port !== '' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
}

function requireContext(context) {
  if (!context || typeof context.registerSecret !== 'function' || typeof context.addCleanup !== 'function' ||
      typeof context.stateDir !== 'string' || !(context.processes instanceof Map)) {
    throw new TypeError('RunContext secret, cleanup, state, and process ownership interfaces are required');
  }
}

function assertRunRootPath(root) {
  if (typeof root !== 'string' || !RUN_ROOT_PATTERN.test(root) || resolve(root) !== root || dirname(root) !== '/tmp') {
    throw new Error('remote owner root must be one exact run-owned /tmp path');
  }
}

async function verifyOwnedDirectory(path, label, expectedMode) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      typeof process.getuid === 'function' && info.uid !== process.getuid() ||
      expectedMode !== undefined && (info.mode & 0o7777) !== expectedMode ||
      await realpath(path) !== resolve(path)) {
    throw new Error(`${label} must be a real, owned private directory`);
  }
  return info;
}

async function verifyRegularOwnedFile(path, label, maximumBytes, expectedMode) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      typeof process.getuid === 'function' && info.uid !== process.getuid() ||
      maximumBytes !== undefined && info.size > maximumBytes ||
      expectedMode !== undefined && (info.mode & 0o777) !== expectedMode ||
      expectedMode !== undefined && (info.mode & 0o077) !== 0 ||
      await realpath(path) !== resolve(path)) {
    throw new Error(`${label} must be an owned regular file with bounded size and safe permissions`);
  }
  return info;
}

function validRootReceipt(value, root, runId, role) {
  return isRecord(value) && value.root === root && value.runId === runId && value.role === role &&
    /^\d+$/.test(String(value.uid)) && /^\d+$/.test(String(value.dev)) && /^\d+$/.test(String(value.ino)) &&
    value.mode === '0700';
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}
