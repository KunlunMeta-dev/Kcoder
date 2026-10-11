// Local, isolated authorization review against the frozen Gateway/Relay candidate.
// One test uses Gateway mock RPC; another uses a scripted stdio app-server fixture
// to exercise the real Gateway broker without a real Engine or model provider.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const candidateRoot = process.env.PHONE_AUTH_CANDIDATE_ROOT ?? join(repoRoot, 'target/private-phone-latency-implementation/after-auth-candidate-20261007-184645');
const candidateDigest = process.env.PHONE_AUTH_CANDIDATE_DIGEST ?? 'cf96615cebfacc5bd1afa4f22bc5cc4b14e3596723fa2d05eb42feef602fc73c';
const candidateCount = Number(process.env.PHONE_AUTH_CANDIDATE_COUNT ?? 326);
const candidate212651Root = join(repoRoot, 'target/private-phone-latency-implementation/after-final-scope-mobile-gateway-20261007-212651');
const candidate212651Digest = '5b6c54a14ae1442941b7719a53026d0825b37850fc3e1efd9aa626e96dc7806f';
const candidate212651Count = 356;
const accessTtlMs = 800;
const socketGraceMs = 400;
const relayAuthority = 'relay.test';
const mobileOrigin = 'https://mobile.test';
const relayRequire = createRequire(join(repoRoot, 'apps/kcoder-relay/package.json'));
const WebSocket = relayRequire('ws');

function credential() { return randomBytes(32).toString('hex'); }
function check(condition, message) { if (!condition) throw new Error(message); }
function timeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

async function verifyFrozenCandidate() {
  let freeze;
  try { freeze = JSON.parse(await readFile(join(candidateRoot, 'freeze.json'), 'utf8')); }
  catch { freeze = JSON.parse(await readFile(join(candidateRoot, 'metadata.json'), 'utf8')); }
  const count = freeze.count ?? freeze.files;
  check(freeze.sourceDigest === candidateDigest && count === candidateCount, 'frozen source metadata does not match the reviewed candidate');
  const manifest = JSON.parse(await readFile(join(candidateRoot, 'sha256.json'), 'utf8'));
  const entries = Object.entries(manifest);
  check(entries.length === count, 'frozen source manifest count mismatch');
  for (const [relative, expected] of entries) {
    const actual = createHash('sha256').update(await readFile(join(candidateRoot, relative))).digest('hex');
    check(actual === expected, `frozen source hash mismatch: ${relative}`);
  }
}

async function verify212651Candidate() {
  const freeze = JSON.parse(await readFile(join(candidate212651Root, 'metadata.json'), 'utf8'));
  check(freeze.sourceDigest === candidate212651Digest && freeze.files === candidate212651Count, '212651 frozen source metadata does not match the reviewed candidate');
  const manifest = JSON.parse(await readFile(join(candidate212651Root, 'sha256.json'), 'utf8'));
  const entries = Object.entries(manifest);
  check(entries.length === candidate212651Count, '212651 frozen source manifest count mismatch');
  for (const [relative, expected] of entries) {
    const actual = createHash('sha256').update(await readFile(join(candidate212651Root, relative))).digest('hex');
    check(actual === expected, `212651 frozen source hash mismatch: ${relative}`);
  }
}

async function makeRuntimeCopy(root, sourceRoot = candidateRoot) {
  const appsRoot = join(root, 'apps');
  const studioSource = join(sourceRoot, 'apps/kcoder-studio');
  const relaySource = join(sourceRoot, 'apps/kcoder-relay');
  const studioTarget = join(appsRoot, 'kcoder-studio');
  const relayTarget = join(appsRoot, 'kcoder-relay');
  await mkdir(appsRoot, { recursive: true });
  await mkdir(studioTarget, { recursive: true });
  await mkdir(relayTarget, { recursive: true });
  await Promise.all([
    cp(join(studioSource, 'dev-server.mjs'), join(studioTarget, 'dev-server.mjs')),
    cp(join(studioSource, 'package.json'), join(studioTarget, 'package.json')),
    cp(join(studioSource, 'src'), join(studioTarget, 'src'), { recursive: true }),
    cp(join(relaySource, 'package.json'), join(relayTarget, 'package.json')),
    cp(join(relaySource, 'src'), join(relayTarget, 'src'), { recursive: true }),
    symlink(join(repoRoot, 'apps/kcoder-studio/node_modules'), join(studioTarget, 'node_modules'), 'dir'),
    symlink(join(repoRoot, 'apps/kcoder-relay/node_modules'), join(relayTarget, 'node_modules'), 'dir'),
  ]);
  const webRoot = join(root, 'web');
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>isolated fixture</title>', { mode: 0o600 });
  return { studioTarget, relayTarget, webRoot };
}

async function authSourceSnapshotDigest(runtime) {
  const files = [
    ['apps/kcoder-studio/dev-server.mjs', join(runtime.studioTarget, 'dev-server.mjs')],
    ['apps/kcoder-studio/src/mobile-device-auth.js', join(runtime.studioTarget, 'src/mobile-device-auth.js')],
    ['apps/kcoder-studio/src/mobile-device-private-storage.js', join(runtime.studioTarget, 'src/mobile-device-private-storage.js')],
    ['apps/kcoder-relay/src/server.mjs', join(runtime.relayTarget, 'src/server.mjs')],
    ['apps/kcoder-relay/src/client.mjs', join(runtime.relayTarget, 'src/client.mjs')],
  ];
  const digest = createHash('sha256');
  for (const [relative, filePath] of files) {
    digest.update(relative).update('\0').update(await readFile(filePath));
  }
  return digest.digest('hex');
}

async function createGatewayState(root, id, authToken) {
  const home = join(root, `home-${id}`);
  const config = join(home, 'config');
  const workspace = join(root, `workspace-${id}`);
  await Promise.all([mkdir(config, { recursive: true, mode: 0o700 }), mkdir(workspace, { recursive: true, mode: 0o700 })]);
  const serversStore = join(config, 'servers.json');
  await writeFile(serversStore, JSON.stringify([
    { id: 'local', label: `isolated-${id}`, runtime: 'kcoder', transport: 'local', workspace },
  ]), { mode: 0o600 });
  return { id, home, config, workspace, serversStore, authToken, port: 0, child: null };
}

async function createBrokerFixtureGatewayState(root, id, authToken, command) {
  const home = join(root, `home-${id}`);
  const config = join(home, 'config');
  const workspace = join(root, `workspace-${id}`);
  await Promise.all([mkdir(config, { recursive: true, mode: 0o700 }), mkdir(workspace, { recursive: true, mode: 0o700 })]);
  const serversStore = join(config, 'servers.json');
  await writeFile(serversStore, JSON.stringify([
    { id: 'local', label: `isolated-${id}`, runtime: 'kcoder', transport: 'local', workspace, command },
  ]), { mode: 0o600 });
  return { id, home, config, workspace, serversStore, authToken, command, mock: false, port: 0, child: null };
}

function isolatedEnvironment(state, webRoot, port) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: state.home,
    TMPDIR: tmpdir(),
    LANG: 'C.UTF-8',
    KCODER_CONFIG_DIR: state.config,
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_AUTH_TOKEN: state.authToken,
    KCODER_STUDIO_AUTH_SESSION_TTL_MS: '3600000',
    KCODER_STUDIO_MOBILE_ACCESS_TTL_MS: String(state.mobileAccessTtlMs ?? accessTtlMs),
    KCODER_STUDIO_MOBILE_SOCKET_GRACE_MS: String(state.mobileSocketGraceMs ?? socketGraceMs),
    KCODER_STUDIO_MOBILE_WEB_ORIGINS: mobileOrigin,
    KCODER_STUDIO_PUBLIC_ORIGINS: `https://${relayAuthority}`,
    KCODER_STUDIO_ALLOWED_HOSTS: `127.0.0.1,localhost,${relayAuthority}`,
    KCODER_STUDIO_MOCK: state.mock === false ? '0' : '1',
    KCODER_STUDIO_WORKSPACE: state.workspace,
    KCODER_STUDIO_SERVERS_STORE: state.serversStore,
    KCODER_STUDIO_WEB_ROOT: webRoot,
  };
}

async function startGateway(state, studioRoot, webRoot, port = 0) {
  const child = (await import('node:child_process')).spawn(process.execPath, ['dev-server.mjs'], {
    cwd: studioRoot,
    env: isolatedEnvironment(state, webRoot, port),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.child = child;
  let output = '';
  let settled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolvePromise, rejectPromise) => { resolveReady = resolvePromise; rejectReady = rejectPromise; });
  const timer = setTimeout(() => { if (!settled) rejectReady(new Error('isolated Gateway startup timed out')); }, 10_000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output = (output + chunk).slice(-8192);
    if (state.captureLifecycleGatewayLog === true) state.lifecycleGatewayOutput = output;
    const match = output.match(/KCoder Studio: http:\/\/127\.0\.0\.1:(\d+)/);
    if (match && !settled) { settled = true; clearTimeout(timer); resolveReady(Number(match[1])); }
  });
  child.stderr.on('data', () => {});
  child.once('error', () => { if (!settled) { settled = true; clearTimeout(timer); rejectReady(new Error('isolated Gateway process failed to start')); } });
  child.once('exit', () => { if (!settled) { settled = true; clearTimeout(timer); rejectReady(new Error('isolated Gateway exited before listening')); } });
  state.port = await ready;
  return state;
}

async function createScriptedAppServerFixture(root) {
  const fixturePath = join(root, 'scripted-app-server.mjs');
  const launcherPath = join(root, 'scripted-app-server');
  const auditPath = join(root, 'app-server-audit.jsonl');
  const fixture = `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const auditPath = ${JSON.stringify(auditPath)};
let threadSequence = 0;
let turnSequence = 0;
function record(message) {
  appendFileSync(auditPath, JSON.stringify({ direction: 'in', method: message.method, params: message.params ?? {}, at: Date.now() }) + '\\n', { mode: 0o600 });
}
function send(message) {
  appendFileSync(auditPath, JSON.stringify({ direction: 'out', method: message.method ?? 'response', at: Date.now() }) + '\\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(message) + '\\n');
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { process.exitCode = 2; return; }
  if (typeof message.method !== 'string') return;
  record(message);
  const id = message.id;
  const params = message.params ?? {};
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2026-07-27', serverInfo: { name: 'scripted-stdio-fixture', version: '1' }, capabilities: { experimental: { residentThreads: true, goalContinuation: true } } } });
  } else if (message.method === 'thread/start') {
    threadSequence += 1;
    send({ jsonrpc: '2.0', id, result: { thread: { id: 'fixture-thread-' + threadSequence } } });
  } else if (message.method === 'thread/resume') {
    send({ jsonrpc: '2.0', id, result: { thread: { id: params.threadId ?? 'fixture-thread-resumed' } } });
  } else if (message.method === 'turn/start') {
    turnSequence += 1;
    const turnId = 'fixture-turn-' + turnSequence;
    const threadId = params.threadId ?? 'fixture-thread-1';
    send({ jsonrpc: '2.0', id, result: { turn: { id: turnId, threadId } } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId, turnId } });
    if (turnSequence === 1) setTimeout(() => send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turnId, turn: { id: turnId, status: 'completed' } } }), 3_500);
  } else if (message.method === 'turn/interrupt') {
    send({ jsonrpc: '2.0', id, result: {} });
    send({ jsonrpc: '2.0', method: 'turn/interrupted', params: { threadId: params.threadId, turnId: params.turnId, turn: { id: params.turnId, status: 'interrupted' } } });
  } else if (message.method === 'browser/start') {
    send({ jsonrpc: '2.0', id, result: { browser: { id: 'fixture-browser-1' } } });
  } else {
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
setInterval(() => {}, 1_000);
`;
  await writeFile(fixturePath, fixture, { mode: 0o600 });
  await writeFile(launcherPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} "$@"\n`, { mode: 0o700 });
  return { fixturePath, launcherPath, auditPath };
}

async function createApprovalHeldAppServerFixture(root) {
  const fixturePath = join(root, 'approval-held-app-server.mjs');
  const launcherPath = join(root, 'approval-held-app-server');
  const auditPath = join(root, 'approval-held-app-server-audit.jsonl');
  const fixture = `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const auditPath = ${JSON.stringify(auditPath)};
let threadSequence = 0;
let turnSequence = 0;
let approvalSequence = 0;
let terminalSequence = 0;
let browserSequence = 0;
const approvals = new Map();
const terminals = new Set();
const browsers = new Set();
function record(direction, method, extra = {}) {
  appendFileSync(auditPath, JSON.stringify({ direction, method, at: Date.now(), ...extra }) + '\\n', { mode: 0o600 });
}
record('meta', 'fixture-process-start', { pid: process.pid });
function send(message) {
  record('out', message.method ?? 'response');
  process.stdout.write(JSON.stringify(message) + '\\n');
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { process.exitCode = 2; return; }
  const id = message.id;
  const params = message.params ?? {};
  if (typeof message.method !== 'string') {
    const pending = approvals.get(id);
    if (!pending) return;
    approvals.delete(id);
    const decision = message.result?.decision ?? 'missing';
    record('in', 'approval-response', { decision });
    if (decision === 'accept') {
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: pending.threadId, turnId: pending.turnId, turn: { id: pending.turnId, status: 'completed' } } });
    }
    return;
  }
  record('in', message.method);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2026-07-27', serverInfo: { name: 'approval-held-stdio-fixture', version: '1' }, capabilities: { experimental: { residentThreads: true, goalContinuation: true } } } });
  } else if (message.method === 'thread/start') {
    threadSequence += 1;
    send({ jsonrpc: '2.0', id, result: { thread: { id: 'held-thread-' + threadSequence } } });
  } else if (message.method === 'thread/read') {
    send({ jsonrpc: '2.0', id, result: { thread: { id: params.threadId, turns: [] } } });
  } else if (message.method === 'turn/start') {
    turnSequence += 1;
    approvalSequence += 1;
    const turnId = 'held-turn-' + turnSequence;
    const threadId = params.threadId ?? 'held-thread-1';
    send({ jsonrpc: '2.0', id, result: { turn: { id: turnId, threadId } } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId, turnId } });
    const approvalId = 'held-approval-' + approvalSequence;
    approvals.set(approvalId, { threadId, turnId });
    send({ jsonrpc: '2.0', id: approvalId, method: 'approval/request', params: { approvalId, threadId, turnId, reason: 'fixture approval remains pending until accepted or disconnected', action: { type: 'command', command: 'echo SYNTHETIC_APPROVAL' }, availableDecisions: ['accept', 'decline', 'cancel'] } });
  } else if (message.method === 'turn/interrupt') {
    for (const [approvalId, pending] of approvals) if (pending.threadId === params.threadId && pending.turnId === params.turnId) approvals.delete(approvalId);
    send({ jsonrpc: '2.0', id, result: {} });
    send({ jsonrpc: '2.0', method: 'turn/interrupted', params: { threadId: params.threadId, turnId: params.turnId, turn: { id: params.turnId, status: 'interrupted' } } });
  } else if (message.method === 'thread/automation/suspend') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (message.method === 'terminal/start') {
    terminalSequence += 1;
    const session_id = 'held-terminal-' + terminalSequence;
    terminals.add(session_id);
    send({ jsonrpc: '2.0', id, result: { session_id, cwd: process.cwd() } });
  } else if (message.method === 'terminal/list') {
    send({ jsonrpc: '2.0', id, result: { sessions: [...terminals].map(session_id => ({ session_id, cwd: process.cwd(), rows: 24, cols: 80 })) } });
  } else if (message.method === 'terminal/close') {
    terminals.delete(params.session_id);
    send({ jsonrpc: '2.0', id, result: { closed: true } });
  } else if (message.method === 'browser/start') {
    browserSequence += 1;
    const session_id = 'held-browser-' + browserSequence;
    browsers.add(session_id);
    send({ jsonrpc: '2.0', id, result: { session_id } });
  } else if (message.method === 'browser/close') {
    browsers.delete(params.session_id);
    send({ jsonrpc: '2.0', id, result: { closed: true } });
  } else {
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
setInterval(() => {}, 1_000);
`;
  await writeFile(fixturePath, fixture, { mode: 0o600 });
  await writeFile(launcherPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} "$@"\n`, { mode: 0o700 });
  return { fixturePath, launcherPath, auditPath };
}

async function readFixtureAudit(auditPath) {
  try {
    return (await readFile(auditPath, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForFixtureAudit(auditPath, predicate, ms = 5_000, message = 'scripted app-server audit condition timed out') {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const events = await readFixtureAudit(auditPath);
    if (predicate(events)) return events;
    await sleep(25);
  }
  throw new Error(message);
}

async function waitUntilWallClock(timestamp, maximumWaitMs, message) {
  check(Number.isSafeInteger(timestamp) && timestamp > 0, 'server supplied an invalid authorization timestamp');
  const deadline = Date.now() + maximumWaitMs;
  while (Date.now() < timestamp) {
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(Math.min(250, timestamp - Date.now()));
  }
}

async function stopGateway(state) {
  const child = state?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').catch(() => {});
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(2500)]);
  if (child.exitCode === null && child.signalCode === null) {
    const killed = once(child, 'exit').catch(() => {});
    child.kill('SIGKILL');
    await Promise.race([killed, sleep(1500)]);
  }
}

async function startRelay(relayModule, clients, options) {
  const relay = await relayModule.startRelay({
    gateways: options.gateways,
    sharedHosts: [relayAuthority],
    controlPort: 0,
    proxyPort: 0,
    connectTimeout: 1500,
    pairingBodyTimeoutMs: 1500,
  });
  const nextClients = [];
  for (const gateway of options.gateways) {
    let onlineResolve;
    const online = new Promise(resolvePromise => { onlineResolve = resolvePromise; });
    const client = clients.startClient({
      url: `http://127.0.0.1:${relay.controlPort}`,
      secret: gateway.secret,
      gatewayId: gateway.id,
      gateway: gateway.baseUrl,
      allowInsecure: true,
      retryMs: 50,
      onOnline: onlineResolve,
    });
    nextClients.push(client);
    await timeout(online, 8_000, 'isolated Relay client did not connect');
  }
  return { relay, clients: nextClients };
}

async function stopClients(clients) {
  for (const client of clients.splice(0)) client.close();
  await sleep(50);
}

function throughRelay(relay, id, path, { method = 'GET', body, headers = {}, origin = mobileOrigin } = {}) {
  const bodyBytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const requestHeaders = {
    host: relayAuthority,
    connection: 'close',
    ...(origin ? { origin } : {}),
    ...headers,
    ...(bodyBytes ? { 'content-type': 'application/json', 'content-length': String(bodyBytes.length) } : {}),
  };
  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = httpRequest({
      host: '127.0.0.1', port: relay.proxyPort, method,
      path: `/g/${id}${path}`,
      headers: requestHeaders,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolvePromise({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.once('aborted', () => rejectPromise(new Error('isolated Relay response aborted')));
      response.once('error', () => rejectPromise(new Error('isolated Relay response failed')));
    });
    outgoing.setTimeout(8_000, () => outgoing.destroy(new Error('isolated Relay request timed out')));
    outgoing.once('error', () => rejectPromise(new Error('isolated Relay request failed')));
    outgoing.end(bodyBytes || undefined);
  });
}

function jsonBody(response) {
  try { return JSON.parse(response.body.toString('utf8')); }
  catch { throw new Error('isolated Gateway returned invalid JSON'); }
}

async function pair(relay, id, token) {
  const response = await throughRelay(relay, id, '/api/mobile/session', {
    method: 'POST', body: { token, durableDeviceAuthorization: true, deviceLabel: `fixture-${id}` },
  });
  assert.equal(response.status, 200, 'isolated durable device pairing succeeds');
  const payload = jsonBody(response);
  assert.equal(payload.capabilities?.mobileRefreshV1, true, 'Gateway advertises durable refresh');
  assert.equal(payload.capabilities?.mobileDeviceManagementV1, true, 'Gateway advertises device management');
  assert.equal(response.headers['set-cookie'], undefined, 'device pairing does not create a browser cookie');
  assert.equal(response.headers['cache-control'], 'no-store', 'device credentials are not cacheable');
  return payload;
}

async function refresh(relay, id, session, rotationId = `review-${randomUUID()}`) {
  const response = await throughRelay(relay, id, '/api/mobile/session/refresh', {
    method: 'POST', body: { refreshToken: session.refreshToken, rotationId, deviceId: session.deviceId },
  });
  assert.equal(response.status, 200, 'refresh works through the exact Relay Gateway route');
  const payload = jsonBody(response);
  assert.equal(payload.deviceId, session.deviceId, 'refresh stays in the same device family');
  assert.equal(payload.authorizationGeneration, session.authorizationGeneration, 'routine rotation preserves authorization identity');
  assert.equal(payload.accessToken !== session.accessToken, true, 'access credential rotates');
  assert.equal(payload.refreshToken !== session.refreshToken, true, 'refresh credential rotates');
  return payload;
}

async function getViaRelay(relay, id, accessToken, path = '/api/servers') {
  return throughRelay(relay, id, path, { headers: { authorization: `Bearer ${accessToken}` } });
}

function openRpc(relay, id, session, { channel = 'runtime' } = {}) {
  const url = `ws://127.0.0.1:${relay.proxyPort}/g/${id}/rpc?token=${encodeURIComponent(session.rpcToken)}&server=local&channel=${encodeURIComponent(channel)}`;
  const socket = new WebSocket(url, {
    headers: { host: relayAuthority, authorization: `Bearer ${session.accessToken}` },
    handshakeTimeout: 5_000,
    perMessageDeflate: false,
  });
  const opened = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('isolated device WebSocket open timed out')), 7_000);
    socket.once('open', () => { clearTimeout(timer); resolvePromise(); });
    socket.once('error', () => { clearTimeout(timer); rejectPromise(new Error('isolated device WebSocket failed to open')); });
    socket.once('unexpected-response', () => { clearTimeout(timer); rejectPromise(new Error('isolated device WebSocket was rejected')); });
  });
  let requestId = 1;
  const pending = new Map();
  const notifications = [];
  const notificationWaiters = [];
  socket.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`isolated mock RPC rejected ${waiter.method}`));
      else waiter.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') {
      notifications.push(message);
      for (const waiter of [...notificationWaiters]) {
        const index = notifications.findIndex(value => value.method === waiter.method && (!waiter.predicate || waiter.predicate(value)));
        if (index >= 0) {
          const [value] = notifications.splice(index, 1);
          notificationWaiters.splice(notificationWaiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(value);
        }
      }
    }
  });
  socket.on('close', () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('isolated device WebSocket closed')); }
    pending.clear();
  });
  return {
    socket,
    opened,
    notifications,
    async request(method, params = {}) {
      await opened;
      const idValue = requestId++;
      const result = new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => { pending.delete(idValue); rejectPromise(new Error(`isolated mock RPC timed out: ${method}`)); }, 5_000);
        pending.set(idValue, { method, resolve: resolvePromise, reject: rejectPromise, timer });
      });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: idValue, method, params }));
      return result;
    },
    async waitForNotification(method, predicate = undefined, ms = 5_000) {
      await opened;
      const index = notifications.findIndex(value => value.method === method && (!predicate || predicate(value)));
      if (index >= 0) return notifications.splice(index, 1)[0];
      return timeout(new Promise((resolvePromise, rejectPromise) => {
        const waiter = { method, predicate, resolve: resolvePromise, reject: rejectPromise, timer: null };
        waiter.timer = setTimeout(() => {
          const waiterIndex = notificationWaiters.indexOf(waiter);
          if (waiterIndex >= 0) notificationWaiters.splice(waiterIndex, 1);
          rejectPromise(new Error(`isolated mock RPC notification timed out: ${method}`));
        }, ms);
        notificationWaiters.push(waiter);
      }), ms + 100, `isolated mock RPC notification timed out: ${method}`);
    },
    respond(idValue, result) { socket.send(JSON.stringify({ jsonrpc: '2.0', id: idValue, result })); },
    close() { if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(); },
  };
}

async function startApprovalTurn(rpc, prompt = 'MOBILE_APPROVAL') {
  await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'phone-auth-review', version: '1' } });
  const startedThread = await rpc.request('thread/start', {});
  const threadId = startedThread.thread?.id;
  assert.equal(typeof threadId, 'string', 'mock runtime starts an isolated thread');
  const startedTurn = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
  const turnId = startedTurn.turn?.id;
  assert.equal(typeof turnId, 'string', 'mock runtime starts a held turn');
  const request = await rpc.waitForNotification('approval/request');
  return { threadId, turnId, approvalRequestId: request.id };
}

async function waitForClose(socket, ms, message) {
  if (socket.readyState === WebSocket.CLOSED) return;
  await timeout(once(socket, 'close'), ms, message);
}

test('frozen mobile device authorization survives refresh/restart and isolates Relay routes without interrupting a live mock turn', { timeout: 60_000 }, async t => {
  await verifyFrozenCandidate();
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kcoder-phone-auth-review-'));
  const clients = [];
  const rpcSockets = [];
  const gateways = [];
  let relayState = null;
  t.after(async () => {
    for (const rpc of rpcSockets) rpc.close();
    await stopClients(clients);
    if (relayState) await relayState.close().catch(() => {});
    await Promise.all(gateways.map(stopGateway));
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const runtime = await makeRuntimeCopy(temporaryRoot);
  const relayModule = await import(pathToFileURL(join(runtime.relayTarget, 'src/server.mjs')).href);
  const clientModule = await import(pathToFileURL(join(runtime.relayTarget, 'src/client.mjs')).href);
  const tokenA = credential(); const tokenB = credential();
  const gatewayA = await createGatewayState(temporaryRoot, 'a', tokenA);
  const gatewayB = await createGatewayState(temporaryRoot, 'b', tokenB);
  gateways.push(gatewayA, gatewayB);
  await Promise.all([
    startGateway(gatewayA, runtime.studioTarget, runtime.webRoot),
    startGateway(gatewayB, runtime.studioTarget, runtime.webRoot),
  ]);
  const relayConfigs = [gatewayA, gatewayB].map((gateway, index) => ({
    id: gateway.id,
    secret: credential(),
    pairingToken: gateway.authToken,
    baseUrl: `http://127.0.0.1:${gateway.port}`,
  }));
  const relayStart = await startRelay(relayModule, clientModule, { gateways: relayConfigs });
  relayState = relayStart.relay;
  clients.push(...relayStart.clients);

  const preflight = await throughRelay(relayState, 'a', '/api/mobile/session/refresh', {
    method: 'OPTIONS',
    headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(preflight.status, 204, 'allowlisted cross-origin Mobile Web refresh preflight passes');
  assert.equal(preflight.headers['access-control-allow-origin'], mobileOrigin, 'CORS echoes only the configured Mobile Web origin');
  assert.equal(preflight.headers['access-control-allow-credentials'], undefined, 'CORS does not enable ambient cookies');
  const deniedPreflight = await throughRelay(relayState, 'a', '/api/mobile/session/refresh', {
    method: 'OPTIONS', origin: 'https://evil.test',
    headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(deniedPreflight.status, 403, 'unallowlisted cross-origin refresh is rejected');

  let sessionA = await pair(relayState, 'a', tokenA);
  let sessionB = await pair(relayState, 'b', tokenB);
  assert.ok(sessionA.expiresAt > Date.now() && sessionA.expiresAt <= Date.now() + accessTtlMs + 200, 'mobile access uses the configured short TTL');
  const wrongRouteRefresh = await throughRelay(relayState, 'b', '/api/mobile/session/refresh', {
    method: 'POST', body: { refreshToken: sessionA.refreshToken, rotationId: `wrong-route-${randomUUID()}`, deviceId: sessionA.deviceId },
  });
  assert.equal(wrongRouteRefresh.status, 401, 'Gateway A refresh credential is rejected at Gateway B');
  assert.equal((await getViaRelay(relayState, 'b', sessionA.accessToken)).status, 401, 'Gateway A access cannot cross into Gateway B');
  assert.equal((await getViaRelay(relayState, 'a', sessionA.accessToken)).status, 200, 'failed cross-route refresh does not invalidate Gateway A');
  assert.equal(jsonBody(await throughRelay(relayState, 'a', '/api/mobile/devices', { headers: { authorization: `Bearer ${sessionA.accessToken}` } })).devices.length, 1, 'device list is local to Gateway A');
  assert.equal(jsonBody(await throughRelay(relayState, 'b', '/api/mobile/devices', { headers: { authorization: `Bearer ${sessionB.accessToken}` } })).devices.length, 1, 'device list is local to Gateway B');

  const authStorePath = join(gatewayA.config, 'mobile-device-auth', 'devices.json');
  const storedAuth = await readFile(authStorePath, 'utf8');
  assert.equal(storedAuth.includes(sessionA.refreshToken), false, 'Gateway stores no refresh plaintext');
  assert.equal(storedAuth.includes(sessionA.accessToken), false, 'Gateway stores no access plaintext');

  const primaryRpc = openRpc(relayState, 'a', sessionA);
  rpcSockets.push(primaryRpc);
  await primaryRpc.opened;
  const longTurn = await startApprovalTurn(primaryRpc);
  const turnStartedAt = Date.now();
  let prior = sessionA;
  let sameRotationRetryChecked = false;
  for (let index = 0; index < 4; index += 1) {
    await sleep(Math.floor(accessTtlMs * 0.8));
    const rotationId = `review-${index}-${randomUUID()}`;
    const next = await refresh(relayState, 'a', prior, rotationId);
    if (!sameRotationRetryChecked) {
      const replay = await throughRelay(relayState, 'a', '/api/mobile/session/refresh', {
        method: 'POST', body: { refreshToken: prior.refreshToken, rotationId, deviceId: prior.deviceId },
      });
      assert.equal(replay.status, 200, 'same rotation ID recovers a lost refresh response');
      assert.equal(jsonBody(replay).refreshToken === next.refreshToken, true, 'rotation replay returns the same refresh result');
      sameRotationRetryChecked = true;
    }
    assert.equal((await getViaRelay(relayState, 'a', prior.accessToken)).status, 401, 'old access is rejected after rotation');
    assert.equal((await getViaRelay(relayState, 'a', next.accessToken)).status, 200, 'new access authorizes Gateway HTTP');
    assert.equal(primaryRpc.socket.readyState, WebSocket.OPEN, 'routine refresh preserves the established WebSocket');
    assert.equal((await primaryRpc.request('thread/list', {})).threads.length >= 0, true, 'the same live socket remains usable after rotation');
    assert.equal(primaryRpc.socket.readyState, WebSocket.OPEN, 'live WebSocket remains open after its RPC response');
    prior = next;
    sessionB = await refresh(relayState, 'b', sessionB, `review-b-${index}-${randomUUID()}`);
  }
  sessionA = prior;
  const longTurnDuration = Date.now() - turnStartedAt;
  assert.ok(longTurnDuration > accessTtlMs * 3, 'held mock turn spans more than three mobile access TTLs');
  assert.equal(primaryRpc.socket.readyState, WebSocket.OPEN, 'held turn has no socket close during routine refresh');
  assert.equal(primaryRpc.notifications.some(value => ['turn/completed', 'turn/interrupted'].includes(value.method)), false, 'routine refresh does not complete or interrupt the held turn');
  primaryRpc.respond(longTurn.approvalRequestId, { decision: 'accept' });
  const completed = await primaryRpc.waitForNotification('turn/completed', value => value.params?.turnId === longTurn.turnId);
  assert.equal(completed.params.turn?.status, 'completed', 'held mock turn completes after several successful rotations');

  let adminSession = await pair(relayState, 'a', tokenA);
  adminSession = await refresh(relayState, 'a', adminSession);
  const devicesBeforeRevoke = jsonBody(await throughRelay(relayState, 'a', '/api/mobile/devices', { headers: { authorization: `Bearer ${adminSession.accessToken}` } })).devices;
  assert.equal(devicesBeforeRevoke.length, 2, 'a full-scope Gateway device grant can see device families on that Gateway');
  sessionA = await refresh(relayState, 'a', sessionA);
  const revokeTurn = await startApprovalTurn(primaryRpc, 'MOBILE_APPROVAL_REVOKE');
  adminSession = await refresh(relayState, 'a', adminSession);
  const revokeResponse = await throughRelay(relayState, 'a', `/api/mobile/devices/${encodeURIComponent(sessionA.deviceId)}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${adminSession.accessToken}` },
  });
  assert.equal(revokeResponse.status, 204, 'a full-scope device grant can revoke another device family on its Gateway');
  await waitForClose(primaryRpc.socket, 3_000, 'explicit device revoke did not close the device WebSocket');
  const revokedRefresh = await throughRelay(relayState, 'a', '/api/mobile/session/refresh', {
    method: 'POST', body: { refreshToken: sessionA.refreshToken, rotationId: `after-revoke-${randomUUID()}`, deviceId: sessionA.deviceId },
  });
  assert.equal(revokedRefresh.status, 401, 'revoked device family cannot refresh');
  assert.equal((await getViaRelay(relayState, 'a', sessionA.accessToken)).status, 401, 'revoked device access cannot make HTTP requests');
  const adminDevicesAfterRevoke = jsonBody(await throughRelay(relayState, 'a', '/api/mobile/devices', { headers: { authorization: `Bearer ${adminSession.accessToken}` } })).devices;
  assert.equal(adminDevicesAfterRevoke.some(device => device.id === sessionA.deviceId), false, 'revoked family is absent from Gateway device listing');
  assert.equal(revokeTurn.turnId.length > 0, true, 'explicit revoke targeted a live mock turn');

  let idleSession = await pair(relayState, 'a', tokenA);
  const idleRpc = openRpc(relayState, 'a', idleSession);
  rpcSockets.push(idleRpc);
  await idleRpc.opened;
  const idleTurn = await startApprovalTurn(idleRpc);
  const noRefreshWait = Math.max(0, idleSession.wsLeaseExpiresAt - Date.now() + 150);
  assert.ok(noRefreshWait <= accessTtlMs + socketGraceMs + 300, 'unrefreshed WebSocket expiry remains bounded');
  await waitForClose(idleRpc.socket, noRefreshWait + 2_000, 'unrefreshed device WebSocket outlived its family lease');
  assert.equal((await getViaRelay(relayState, 'a', idleSession.accessToken)).status, 401, 'expired short access is rejected while the socket lease expires');
  const recoveredIdleSession = await refresh(relayState, 'a', idleSession);
  idleSession = recoveredIdleSession;
  assert.equal((await getViaRelay(relayState, 'a', idleSession.accessToken)).status, 200, 'refresh credential remains usable after its old socket lease closes');
  const recoveredRpc = openRpc(relayState, 'a', idleSession);
  rpcSockets.push(recoveredRpc);
  await recoveredRpc.opened;
  assert.equal((await recoveredRpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'review-recovery', version: '1' } })).serverInfo.name, 'kcoder-studio-mock', 'device can establish a fresh socket after lease expiry');
  recoveredRpc.close();
  assert.equal(idleTurn.turnId.length > 0, true, 'bounded expiry exercised a live mock turn');

  await stopGateway(gatewayA);
  await startGateway(gatewayA, runtime.studioTarget, runtime.webRoot, gatewayA.port);
  assert.equal((await getViaRelay(relayState, 'a', idleSession.accessToken)).status, 401, 'Gateway restart clears in-memory access grants');
  const afterGatewayRestart = await refresh(relayState, 'a', idleSession);
  assert.equal((await getViaRelay(relayState, 'a', afterGatewayRestart.accessToken)).status, 200, 'Gateway restart recovers the durable device family');
  idleSession = afterGatewayRestart;

  sessionB = await refresh(relayState, 'b', sessionB);
  await stopClients(clients);
  await relayState.close();
  relayState = null;
  const relayAfterRestart = await startRelay(relayModule, clientModule, { gateways: relayConfigs });
  relayState = relayAfterRestart.relay;
  clients.push(...relayAfterRestart.clients);
  assert.equal((await getViaRelay(relayState, 'a', idleSession.accessToken)).status, 401, 'Relay restart clears its in-memory access map');
  const afterRelayRestart = await refresh(relayState, 'a', idleSession);
  assert.equal((await getViaRelay(relayState, 'a', afterRelayRestart.accessToken)).status, 200, 'Relay restart restores access through Gateway-owned refresh');
  assert.equal((await getViaRelay(relayState, 'b', sessionB.accessToken)).status, 401, 'Relay restart clears its Gateway B access map too');
  sessionB = await refresh(relayState, 'b', sessionB);
  assert.equal((await getViaRelay(relayState, 'b', sessionB.accessToken)).status, 200, 'Gateway B recovers only through its own refresh route');
  assert.equal((await getViaRelay(relayState, 'a', sessionB.accessToken)).status, 401, 'Gateway B access remains rejected on Gateway A after Relay restart');

  const noAuth = await createGatewayState(temporaryRoot, 'noauth', '');
  gateways.push(noAuth);
  await startGateway(noAuth, runtime.studioTarget, runtime.webRoot);
  const legacyPair = await fetch(`http://127.0.0.1:${noAuth.port}/api/mobile/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: credential(), durableDeviceAuthorization: true }),
  });
  assert.equal(legacyPair.status, 200, 'no-auth Gateway preserves the legacy pairing path');
  const legacyPayload = await legacyPair.json();
  assert.equal(legacyPayload.capabilities?.mobileRefreshV1, false, 'no-auth Gateway does not advertise durable pairing');
  assert.equal(legacyPayload.capabilities?.mobileDeviceManagementV1, false, 'no-auth Gateway does not advertise device management');
  const noAuthRefresh = await fetch(`http://127.0.0.1:${noAuth.port}/api/mobile/session/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: credential(), rotationId: `noauth-${randomUUID()}` }),
  });
  assert.equal(noAuthRefresh.status, 403, 'no-auth Gateway refuses persistent refresh');

  assert.equal((await getViaRelay(relayState, 'a', afterRelayRestart.accessToken)).status, 200, 'A route remains usable after isolated Gateway/Relay restarts');
  assert.equal((await getViaRelay(relayState, 'b', sessionB.accessToken)).status, 200, 'B route retains its own live session after route-specific refresh');

  // Invalid refresh attempts must not poison a valid device grant at the same
  // Relay peer. The older candidate intentionally reproduces the prior bug;
  // current candidates must keep the valid refresh usable.
  for (let index = 0; index < 4; index += 1) {
    const failed = await throughRelay(relayState, 'b', '/api/mobile/session/refresh', {
      method: 'POST', body: { refreshToken: credential(), rotationId: `rate-probe-${index}-${randomUUID()}` },
    });
    assert.equal(failed.status, 401, 'synthetic invalid refresh remains isolated to the fixture');
  }
  const validAfterInvalidBurst = await throughRelay(relayState, 'b', '/api/mobile/session/refresh', {
    method: 'POST', body: { refreshToken: sessionB.refreshToken, rotationId: `valid-after-rate-probe-${randomUUID()}`, deviceId: sessionB.deviceId },
  });
  const expectedValidStatus = candidateDigest === 'cf96615cebfacc5bd1afa4f22bc5cc4b14e3596723fa2d05eb42feef602fc73c' ? 429 : 200;
  assert.equal(validAfterInvalidBurst.status, expectedValidStatus, 'invalid refreshes do not block a valid device refresh in the reviewed candidate');
  if (expectedValidStatus === 429) t.diagnostic('older candidate finding reproduced in isolated fixture: invalid refreshes cause a valid Gateway B refresh to receive 429; no secrets or external sessions used');
  else t.diagnostic('valid Gateway B refresh remained usable after invalid refresh attempts from the same Relay peer');
});

test('routine refresh preserves a broker-owned stdio turn; explicit device revoke drains it and owned browser resources', { timeout: 45_000 }, async t => {
  await verifyFrozenCandidate();
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kcoder-phone-auth-broker-review-'));
  const clients = [];
  const rpcSockets = [];
  const gateways = [];
  let relayState = null;
  t.after(async () => {
    for (const rpc of rpcSockets) rpc.close();
    await stopClients(clients);
    if (relayState) await relayState.close().catch(() => {});
    await Promise.all(gateways.map(stopGateway));
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const runtime = await makeRuntimeCopy(temporaryRoot);
  const relayModule = await import(pathToFileURL(join(runtime.relayTarget, 'src/server.mjs')).href);
  const clientModule = await import(pathToFileURL(join(runtime.relayTarget, 'src/client.mjs')).href);
  const fixture = await createScriptedAppServerFixture(temporaryRoot);
  const gatewayToken = credential();
  const gateway = await createBrokerFixtureGatewayState(temporaryRoot, 'broker', gatewayToken, fixture.launcherPath);
  gateways.push(gateway);
  await startGateway(gateway, runtime.studioTarget, runtime.webRoot);

  const relayStart = await startRelay(relayModule, clientModule, {
    gateways: [{ id: gateway.id, secret: credential(), pairingToken: gateway.authToken, baseUrl: `http://127.0.0.1:${gateway.port}` }],
  });
  relayState = relayStart.relay;
  clients.push(...relayStart.clients);

  let device = await pair(relayState, gateway.id, gatewayToken);
  let administrator = await pair(relayState, gateway.id, gatewayToken);
  const rpc = openRpc(relayState, gateway.id, device);
  rpcSockets.push(rpc);
  await rpc.opened;
  const initialized = await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'broker-auth-review', version: '1' } });
  assert.equal(initialized.serverInfo.name, 'scripted-stdio-fixture', 'Gateway broker returns the scripted stdio app-server handshake');
  assert.equal(initialized.capabilities?.experimental?.goalContinuation, true, 'fixture enables the broker automation cleanup path');

  const thread = await rpc.request('thread/start', {});
  const threadId = thread.thread?.id;
  assert.equal(threadId, 'fixture-thread-1', 'broker forwards thread creation to the scripted child');
  const firstTurn = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'held fixture turn' }] });
  const firstTurnId = firstTurn.turn?.id;
  assert.equal(firstTurnId, 'fixture-turn-1', 'broker forwards the active turn to the scripted child');
  await rpc.waitForNotification('turn/started', value => value.params?.turnId === firstTurnId);
  const browserRpc = openRpc(relayState, gateway.id, device, { channel: 'browser' });
  rpcSockets.push(browserRpc);
  await browserRpc.opened;
  await browserRpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'broker-browser-review', version: '1' } });
  const browser = await browserRpc.request('browser/start', {});
  assert.equal(browser.browser?.id, 'fixture-browser-1', 'broker records an owned browser resource');

  const startedAt = Date.now();
  let priorDevice = device;
  for (let index = 0; index < 4; index += 1) {
    await sleep(Math.floor(accessTtlMs * 0.8));
    device = await refresh(relayState, gateway.id, priorDevice, `broker-routine-${index}-${randomUUID()}`);
    assert.equal(rpc.socket.readyState, WebSocket.OPEN, 'routine rotation keeps the existing Gateway-broker WebSocket open');
    assert.equal(typeof (await rpc.request('thread/read', { threadId })), 'object', 'broker remains responsive on the same socket during refresh');
    priorDevice = device;
  }
  assert.ok(Date.now() - startedAt > accessTtlMs * 3, 'scripted active turn remains held for more than three access TTLs');
  const firstCompleted = await rpc.waitForNotification('turn/completed', value => value.params?.turnId === firstTurnId, 8_000)
    .catch(async error => {
      const methods = (await readFixtureAudit(fixture.auditPath)).map(event => `${event.direction}:${event.method}`).join(',');
      throw new Error(`${error.message}; scripted fixture audit: ${methods}`);
    });
  assert.equal(firstCompleted.params.turn?.status, 'completed', 'fixture completes the same active turn after the refresh sequence');
  let audit = await readFixtureAudit(fixture.auditPath);
  assert.equal(audit.filter(event => event.direction === 'in' && event.method === 'turn/interrupt').length, 0, 'routine refresh caused no broker turn/interrupt');
  assert.equal(audit.filter(event => event.direction === 'in' && event.method === 'thread/automation/suspend').length, 0, 'routine refresh caused no broker automation suspend');
  assert.equal(audit.filter(event => event.direction === 'in' && event.method === 'browser/close').length, 0, 'routine refresh caused no broker resource cleanup');

  const secondTurn = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'revoke fixture turn' }] });
  const secondTurnId = secondTurn.turn?.id;
  assert.equal(secondTurnId, 'fixture-turn-2', 'the same resident thread can start another active turn');
  await rpc.waitForNotification('turn/started', value => value.params?.turnId === secondTurnId);
  administrator = await refresh(relayState, gateway.id, administrator, `broker-admin-${randomUUID()}`);
  const revoke = await throughRelay(relayState, gateway.id, `/api/mobile/devices/${encodeURIComponent(device.deviceId)}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${administrator.accessToken}` },
  });
  assert.equal(revoke.status, 204, 'full-scope device administrator revokes the active device family');
  await waitForClose(rpc.socket, 3_000, 'device revocation did not close its broker WebSocket');
  audit = await waitForFixtureAudit(fixture.auditPath, events =>
    events.some(event => event.direction === 'in' && event.method === 'turn/interrupt') &&
    events.some(event => event.direction === 'in' && event.method === 'thread/automation/suspend') &&
    events.some(event => event.direction === 'in' && event.method === 'browser/close'),
  5_000, 'broker did not issue all expected cleanup requests after explicit revocation');
  assert.equal(audit.filter(event => event.direction === 'in' && event.method === 'turn/interrupt').length, 1, 'explicit revoke interrupts the held turn exactly once');
  assert.equal(audit.filter(event => event.direction === 'in' && event.method === 'thread/automation/suspend').length, 1, 'explicit revoke suspends the owned thread automation');
  assert.equal(audit.filter(event => event.direction === 'in' && event.method === 'browser/close').length, 1, 'explicit revoke closes the owned browser resource');
  t.diagnostic('broker continuity evidence uses the frozen Gateway and Relay plus a scripted stdio app-server fixture; no Rust Engine, Provider, or user session was started');
});

test('212651 natural-clock approval hold: routine rotation preserves broker ownership; revoke and lease expiry detach exactly once', { timeout: 90_000 }, async t => {
  await verify212651Candidate();
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kcoder-phone-auth-212651-lifecycle-'));
  const evidenceDirectory = process.env.PHONE_AUTH_LIFECYCLE_EVIDENCE_DIR;
  const serverTimeline = [];
  const clients = [];
  const rpcSockets = [];
  const gateways = [];
  let fixture = null;
  let relayState = null;
  let gateway = null;
  t.after(async () => {
    if (evidenceDirectory) {
      try {
        await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
        const audit = fixture ? await readFixtureAudit(fixture.auditPath) : [];
        await writeFile(join(evidenceDirectory, 'stdio-fixture-audit.jsonl'), audit.map(event => JSON.stringify(event)).join('\n') + (audit.length ? '\n' : ''), { mode: 0o600 });
        const fixtureProcess = audit.find(event => event.direction === 'meta' && event.method === 'fixture-process-start');
        const gatewayLog = String(gateway?.lifecycleGatewayOutput ?? '')
          .replaceAll(gateway?.authToken ?? '', '[REDACTED]')
          .replace(/(authorization|token|secret|bearer)(\s*[:=]\s*)[^\s,]+/gi, '$1$2[REDACTED]');
        await writeFile(join(evidenceDirectory, 'gateway-startup.log'), gatewayLog, { mode: 0o600 });
        await writeFile(join(evidenceDirectory, 'process-and-server-time.json'), JSON.stringify({
          evidenceCapturedAt: Date.now(),
          testWorkerPid: process.pid,
          testWorkerParentPid: process.ppid,
          relayOwnerPid: process.pid,
          gatewayPid: gateway?.child?.pid ?? null,
          gatewayPort: gateway?.port ?? null,
          stdioFixturePid: fixtureProcess?.pid ?? null,
          candidate: { path: 'after-final-scope-mobile-gateway-20261007-212651', files: candidate212651Count, sourceDigest: candidate212651Digest },
          serverTimeline,
        }, null, 2) + '\n', { mode: 0o600 });
      } catch (error) {
        t.diagnostic(`lifecycle evidence capture failed; continuing exact process cleanup: ${error instanceof Error ? error.message : 'unknown evidence error'}`);
      }
    }
    for (const rpc of rpcSockets) rpc.close();
    await stopClients(clients);
    if (relayState) await relayState.close().catch(() => {});
    await Promise.all(gateways.map(stopGateway));
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const accessTtl = 6_000;
  const socketGrace = 2_000;
  const runtime = await makeRuntimeCopy(temporaryRoot, candidate212651Root);
  const relayModule = await import(pathToFileURL(join(runtime.relayTarget, 'src/server.mjs')).href);
  const clientModule = await import(pathToFileURL(join(runtime.relayTarget, 'src/client.mjs')).href);
  fixture = await createApprovalHeldAppServerFixture(temporaryRoot);
  const gatewayToken = credential();
  gateway = await createBrokerFixtureGatewayState(temporaryRoot, '212651-lifecycle', gatewayToken, fixture.launcherPath);
  gateway.mobileAccessTtlMs = accessTtl;
  gateway.mobileSocketGraceMs = socketGrace;
  gateway.captureLifecycleGatewayLog = true;
  gateways.push(gateway);
  await startGateway(gateway, runtime.studioTarget, runtime.webRoot);
  serverTimeline.push({ event: 'gateway-started', observedAt: Date.now(), pid: gateway.child.pid, port: gateway.port, runtime: 'real Gateway broker with scripted stdio app-server fixture' });

  const relayStart = await startRelay(relayModule, clientModule, {
    gateways: [{ id: gateway.id, secret: credential(), pairingToken: gateway.authToken, baseUrl: `http://127.0.0.1:${gateway.port}` }],
  });
  relayState = relayStart.relay;
  clients.push(...relayStart.clients);

  let device = await pair(relayState, gateway.id, gatewayToken);
  serverTimeline.push({ event: 'primary-paired', observedAt: Date.now(), accessExpiresAt: device.expiresAt, wsLeaseExpiresAt: device.wsLeaseExpiresAt });
  assert.ok(device.expiresAt > Date.now() && device.expiresAt - Date.now() <= accessTtl + 250, 'Gateway returns the real short access expiry');
  assert.ok(device.wsLeaseExpiresAt >= device.expiresAt && device.wsLeaseExpiresAt <= device.expiresAt + socketGrace + 250, 'Gateway returns a separately bounded WebSocket lease');
  const rpc = openRpc(relayState, gateway.id, device);
  rpcSockets.push(rpc);
  await rpc.opened;
  const initialized = await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: '212651-natural-lease-review', version: '1' } });
  assert.equal(initialized.serverInfo.name, 'approval-held-stdio-fixture', '212651 Gateway broker connects to the approval-held scripted stdio child');
  assert.equal(initialized.capabilities?.experimental?.goalContinuation, true, 'fixture enables the broker automation-suspend contract');
  const thread = await rpc.request('thread/start', {});
  const threadId = thread.thread?.id;
  assert.equal(typeof threadId, 'string', 'broker creates a fixture thread');
  const firstTurn = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'keep this approval pending across routine refresh' }] });
  const firstTurnId = firstTurn.turn?.id;
  assert.equal(typeof firstTurnId, 'string', 'broker starts the approval-held fixture turn');
  await rpc.waitForNotification('turn/started', value => value.params?.turnId === firstTurnId);
  const firstApproval = await rpc.waitForNotification('approval/request', value => value.params?.approvalId === 'held-approval-1');
  assert.notEqual(firstApproval.id, undefined, 'the fixture leaves an app-server approval request pending');
  const heldAt = Date.now();

  const terminal = await rpc.request('terminal/start', { cwd: gateway.workspace });
  assert.equal(typeof terminal.session_id, 'string', 'scripted app-server creates a protocol-level live terminal fixture');
  assert.ok((await rpc.request('terminal/list')).sessions.some(item => item.session_id === terminal.session_id), 'the broker reports the live fixture terminal');
  const browserRpc = openRpc(relayState, gateway.id, device, { channel: 'browser' });
  rpcSockets.push(browserRpc);
  await browserRpc.opened;
  await browserRpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: '212651-browser-resource-review', version: '1' } });
  const browser = await browserRpc.request('browser/start', { url: 'https://fixture.invalid' });
  assert.equal(typeof browser.session_id, 'string', 'scripted app-server creates a protocol-level browser fixture');

  const rotationCount = 6;
  for (let index = 0; index < rotationCount; index += 1) {
    await waitUntilWallClock(device.expiresAt - 1_500, 10_000, 'routine refresh did not reach the server-issued access renewal window');
    const priorExpiry = device.expiresAt;
    device = await refresh(relayState, gateway.id, device, `212651-held-${index}-${randomUUID()}`);
    serverTimeline.push({ event: 'routine-refresh', index: index + 1, observedAt: Date.now(), priorAccessExpiresAt: priorExpiry, accessExpiresAt: device.expiresAt, wsLeaseExpiresAt: device.wsLeaseExpiresAt });
    assert.ok(device.expiresAt > priorExpiry && device.expiresAt > Date.now(), 'successful rotation advances the server-issued access expiry');
    assert.equal(rpc.socket.readyState, WebSocket.OPEN, 'ordinary rotation does not replace or close the runtime socket owner');
    assert.equal(browserRpc.socket.readyState, WebSocket.OPEN, 'ordinary rotation does not close the browser resource channel');
    assert.ok((await rpc.request('thread/read', { threadId })).thread, 'the same broker-owned thread remains readable on the original socket');
    assert.ok((await rpc.request('terminal/list')).sessions.some(item => item.session_id === terminal.session_id), 'the live terminal remains attached to the same broker');
    const audit = await readFixtureAudit(fixture.auditPath);
    for (const method of ['turn/interrupt', 'thread/automation/suspend', 'browser/close', 'terminal/close']) {
      assert.equal(audit.filter(event => event.direction === 'in' && event.method === method).length, 0, `routine rotation did not trigger ${method}`);
    }
    assert.equal(audit.filter(event => event.direction === 'out' && event.method === 'turn/completed').length, 0, 'approval-held work has not auto-completed during rotation');
  }
  assert.ok(Date.now() - heldAt > accessTtl * 3, 'the approval remains pending for more than three configured access TTLs');
  rpc.respond(firstApproval.id, { decision: 'accept' });
  const completed = await rpc.waitForNotification('turn/completed', value => value.params?.turnId === firstTurnId, 5_000);
  assert.equal(completed.params.turn?.status, 'completed', 'the same approval-held turn completes only after an explicit client decision');
  let audit = await waitForFixtureAudit(fixture.auditPath, events => events.some(event => event.direction === 'in' && event.method === 'approval-response' && event.decision === 'accept'), 5_000);
  assert.equal(audit.filter(event => event.direction === 'in' && event.method === 'approval-response' && event.decision === 'accept').length, 1, 'the scripted app-server received one explicit approval decision');

  const revokeTurn = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'remain pending until this device is revoked' }] });
  const revokeTurnId = revokeTurn.turn?.id;
  await rpc.waitForNotification('turn/started', value => value.params?.turnId === revokeTurnId);
  await rpc.waitForNotification('approval/request', value => value.params?.approvalId === 'held-approval-2');
  const administrator = await pair(relayState, gateway.id, gatewayToken);
  const beforeRevoke = (await readFixtureAudit(fixture.auditPath)).length;
  const revoke = await throughRelay(relayState, gateway.id, `/api/mobile/devices/${encodeURIComponent(device.deviceId)}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${administrator.accessToken}` },
  });
  serverTimeline.push({ event: 'explicit-revoke', observedAt: Date.now(), status: revoke.status, runtimeSocketClosed: rpc.socket.readyState === WebSocket.CLOSED, browserSocketClosed: browserRpc.socket.readyState === WebSocket.CLOSED });
  assert.equal(revoke.status, 204, 'a separately paired full-scope device revokes the active device family');
  await Promise.all([
    waitForClose(rpc.socket, 3_000, 'explicit revoke did not close the runtime WebSocket'),
    waitForClose(browserRpc.socket, 3_000, 'explicit revoke did not close the browser WebSocket'),
  ]);
  audit = await waitForFixtureAudit(fixture.auditPath, events => {
    const delta = events.slice(beforeRevoke);
    return ['turn/interrupt', 'thread/automation/suspend', 'browser/close'].every(method => delta.some(event => event.direction === 'in' && event.method === method));
  }, 5_000, 'explicit revoke did not produce the broker cleanup requests');
  const revokeAudit = audit.slice(beforeRevoke);
  for (const method of ['turn/interrupt', 'thread/automation/suspend', 'browser/close']) {
    assert.equal(revokeAudit.filter(event => event.direction === 'in' && event.method === method).length, 1, `explicit revoke issues ${method} exactly once`);
  }
  assert.equal(revokeAudit.filter(event => event.direction === 'out' && event.method === 'turn/interrupted').length, 1, 'the fixture confirms exactly one interrupted event after revoke');
  assert.equal(revokeAudit.filter(event => event.direction === 'in' && event.method === 'terminal/close').length, 0, 'broker retains its live terminal across client detach by existing contract');
  const revokedRefresh = await throughRelay(relayState, gateway.id, '/api/mobile/session/refresh', {
    method: 'POST', body: { refreshToken: device.refreshToken, rotationId: `revoked-${randomUUID()}`, deviceId: device.deviceId },
  });
  assert.equal(revokedRefresh.status, 401, 'device revocation rejects its durable refresh credential');

  const expiringDevice = await pair(relayState, gateway.id, gatewayToken);
  serverTimeline.push({ event: 'expiry-device-paired', observedAt: Date.now(), accessExpiresAt: expiringDevice.expiresAt, wsLeaseExpiresAt: expiringDevice.wsLeaseExpiresAt });
  assert.ok(expiringDevice.expiresAt > Date.now() + 3_000, 'natural-expiry fixture starts with enough real lease time for setup');
  assert.ok(expiringDevice.wsLeaseExpiresAt > expiringDevice.expiresAt, 'natural-expiry fixture has an explicit post-access WebSocket grace');
  const expiryRpc = openRpc(relayState, gateway.id, expiringDevice);
  rpcSockets.push(expiryRpc);
  await expiryRpc.opened;
  await expiryRpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: '212651-natural-expiry-runtime', version: '1' } });
  const expiryThread = await expiryRpc.request('thread/start', {});
  const expiryThreadId = expiryThread.thread?.id;
  const expiryTurn = await expiryRpc.request('turn/start', { threadId: expiryThreadId, input: [{ type: 'text', text: 'remain pending until the natural family lease expires' }] });
  const expiryTurnId = expiryTurn.turn?.id;
  await expiryRpc.waitForNotification('turn/started', value => value.params?.turnId === expiryTurnId);
  await expiryRpc.waitForNotification('approval/request', value => value.params?.approvalId === 'held-approval-3');
  const expiryTerminal = await expiryRpc.request('terminal/start', { cwd: gateway.workspace });
  assert.equal(typeof expiryTerminal.session_id, 'string', 'expiry case owns a live terminal protocol fixture');
  const expiryBrowserRpc = openRpc(relayState, gateway.id, expiringDevice, { channel: 'browser' });
  rpcSockets.push(expiryBrowserRpc);
  await expiryBrowserRpc.opened;
  await expiryBrowserRpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: '212651-natural-expiry-browser', version: '1' } });
  const expiryBrowser = await expiryBrowserRpc.request('browser/start', { url: 'https://expiry.fixture.invalid' });
  assert.equal(typeof expiryBrowser.session_id, 'string', 'expiry case owns a browser protocol fixture');
  const beforeNaturalExpiry = (await readFixtureAudit(fixture.auditPath)).length;

  await waitUntilWallClock(expiringDevice.expiresAt + 100, accessTtl + 3_000, 'server-issued short access expiry was not reached on the real clock');
  const expiredAccess = await getViaRelay(relayState, gateway.id, expiringDevice.accessToken);
  serverTimeline.push({ event: 'natural-access-expiry', observedAt: Date.now(), expectedAt: expiringDevice.expiresAt, status: expiredAccess.status, runtimeSocketOpen: expiryRpc.socket.readyState === WebSocket.OPEN, browserSocketOpen: expiryBrowserRpc.socket.readyState === WebSocket.OPEN });
  assert.equal(expiredAccess.status, 401, 'natural access expiry rejects subsequent HTTP requests');
  assert.ok(Date.now() < expiringDevice.wsLeaseExpiresAt, 'HTTP authorization expired before the bounded family WebSocket lease');
  assert.equal(expiryRpc.socket.readyState, WebSocket.OPEN, 'the existing runtime socket remains within its explicit grace lease');
  assert.equal(expiryBrowserRpc.socket.readyState, WebSocket.OPEN, 'the existing browser socket remains within its explicit grace lease');
  assert.ok((await expiryRpc.request('thread/read', { threadId: expiryThreadId })).thread, 'an already-established socket remains usable during the bounded grace');
  await waitUntilWallClock(expiringDevice.wsLeaseExpiresAt + 100, socketGrace + 3_000, 'server-issued WebSocket family lease did not reach natural expiry');
  await Promise.all([
    waitForClose(expiryRpc.socket, socketGrace + 3_000, 'natural family lease expiry did not close the runtime WebSocket'),
    waitForClose(expiryBrowserRpc.socket, socketGrace + 3_000, 'natural family lease expiry did not close the browser WebSocket'),
  ]);
  serverTimeline.push({ event: 'natural-family-lease-expiry', observedAt: Date.now(), expectedAt: expiringDevice.wsLeaseExpiresAt, runtimeSocketClosed: expiryRpc.socket.readyState === WebSocket.CLOSED, browserSocketClosed: expiryBrowserRpc.socket.readyState === WebSocket.CLOSED });
  audit = await waitForFixtureAudit(fixture.auditPath, events => {
    const delta = events.slice(beforeNaturalExpiry);
    return ['turn/interrupt', 'thread/automation/suspend', 'browser/close'].every(method => delta.some(event => event.direction === 'in' && event.method === method));
  }, 5_000, 'natural family expiry did not produce the broker cleanup requests');
  const expiryAudit = audit.slice(beforeNaturalExpiry);
  for (const method of ['turn/interrupt', 'thread/automation/suspend', 'browser/close']) {
    assert.equal(expiryAudit.filter(event => event.direction === 'in' && event.method === method).length, 1, `natural family expiry issues ${method} exactly once`);
  }
  assert.equal(expiryAudit.filter(event => event.direction === 'out' && event.method === 'turn/interrupted').length, 1, 'the fixture confirms exactly one interrupted event after natural expiry');
  assert.equal(expiryAudit.filter(event => event.direction === 'in' && event.method === 'terminal/close').length, 0, 'broker retains the live terminal across natural client detach by existing contract');
  t.diagnostic('212651 test uses real Gateway and Relay plus a synthetic approval-held stdio protocol fixture; terminal/browser are protocol objects, goalContinuation only observes suspend RPCs, and no Rust Engine, Provider, user session, OS clock override, Chrome, or Cargo build is involved');
});

test('current working source separates invalid refresh failures from valid grants and applies bounded Relay peer admission', { timeout: 45_000 }, async t => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kcoder-phone-auth-current-review-'));
  const clients = [];
  const gateways = [];
  let relayState = null;
  t.after(async () => {
    await stopClients(clients);
    if (relayState) await relayState.close().catch(() => {});
    await Promise.all(gateways.map(stopGateway));
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const runtime = await makeRuntimeCopy(temporaryRoot, repoRoot);
  const sourceDigest = await authSourceSnapshotDigest(runtime);
  t.diagnostic(`active-worktree auth source snapshot (Gateway/Relay auth files): sha256 ${sourceDigest}`);
  const relayModule = await import(pathToFileURL(join(runtime.relayTarget, 'src/server.mjs')).href);
  const clientModule = await import(pathToFileURL(join(runtime.relayTarget, 'src/client.mjs')).href);
  const gatewayToken = credential();
  const gateway = await createGatewayState(temporaryRoot, 'current', gatewayToken);
  gateways.push(gateway);
  await startGateway(gateway, runtime.studioTarget, runtime.webRoot);
  const relayStart = await startRelay(relayModule, clientModule, {
    gateways: [{ id: gateway.id, secret: credential(), pairingToken: gateway.authToken, baseUrl: `http://127.0.0.1:${gateway.port}` }],
  });
  relayState = relayStart.relay;
  clients.push(...relayStart.clients);

  const firstDevice = await pair(relayState, gateway.id, gatewayToken);
  for (let index = 0; index < 6; index += 1) {
    const failed = await throughRelay(relayState, gateway.id, '/api/mobile/session/refresh', {
      method: 'POST', body: { refreshToken: credential(), rotationId: `invalid-current-${index}-${randomUUID()}` },
    });
    assert.equal(failed.status, index < 5 ? 401 : 429, 'Gateway bounds invalid-only refresh failures without changing the first five responses');
  }

  const validAfterInvalidBurst = await refresh(relayState, gateway.id, firstDevice, `valid-current-after-invalid-${randomUUID()}`);
  assert.equal((await getViaRelay(relayState, gateway.id, validAfterInvalidBurst.accessToken)).status, 200, 'a valid device refresh remains available after invalid refresh attempts');
  const secondDevice = await pair(relayState, gateway.id, gatewayToken);
  assert.equal(secondDevice.capabilities?.mobileRefreshV1, true, 'pairing remains available after invalid refresh attempts');

  let sixtieth;
  for (let index = 6; index < 59; index += 1) {
    sixtieth = await throughRelay(relayState, gateway.id, '/api/mobile/session/refresh', {
      method: 'POST', body: { refreshToken: credential(), rotationId: `relay-peer-${index}-${randomUUID()}` },
    });
    if (index < 58) assert.equal(sixtieth.status, 429, 'Gateway continues rejecting invalid credentials after its invalid-only threshold');
  }
  assert.equal(sixtieth.status, 429, 'the 60th refresh request reaches Gateway and is rejected by its invalid-only bucket');
  assert.match(sixtieth.body.toString('utf8'), /Device refresh rejected/, 'the 60th response is the Gateway invalid-credential result');
  const sixtyFirst = await throughRelay(relayState, gateway.id, '/api/mobile/session/refresh', {
    method: 'POST', body: { refreshToken: credential(), rotationId: `relay-peer-61-${randomUUID()}` },
  });
  assert.equal(sixtyFirst.status, 429, 'Relay admits no more than sixty refresh requests from one real peer per minute');
  assert.equal(sixtyFirst.body.toString('utf8'), 'Too Many Requests\n', 'the 61st response is generated at Relay before reaching Gateway');
});
