// Actual Studio Gateway HTTP authentication and WebSocket routing through the
// multi-Gateway Relay. KCODER_STUDIO_MOCK=1 supplies only model-independent RPC.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import WebSocket from 'ws';
import { startRelay } from '../src/server.mjs';
import { startClient } from '../src/client.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const studioRoot = join(repoRoot, 'apps', 'kcoder-studio');
const authority = 'multigateway-studio.test:8451';
const origin = `http://${authority}`;
const ids = ['a', 'b'];

function token() {
  return randomBytes(32).toString('hex');
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolvePromise(value); },
      error => { clearTimeout(timer); rejectPromise(error); },
    );
  });
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function stopGateway(gateway) {
  const child = gateway?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  let timer;
  const exited = await Promise.race([
    closed.then(() => true),
    new Promise(resolveExit => { timer = setTimeout(() => resolveExit(false), 3000); }),
  ]);
  clearTimeout(timer);
  if (exited) return;
  const forceClosed = once(child, 'close');
  child.kill('SIGKILL');
  await forceClosed;
}

async function startGateway({ stateDir, id, label, loginToken }) {
  const workspace = join(stateDir, 'workspace');
  const serverStore = join(stateDir, 'servers.json');
  const child = spawn(process.execPath, ['dev-server.mjs'], {
    cwd: studioRoot,
    env: {
      PATH: process.env.PATH || '',
      HOME: stateDir,
      TMPDIR: stateDir,
      LANG: process.env.LANG || 'C',
      KCODER_STUDIO_HOST: '127.0.0.1',
      KCODER_STUDIO_PORT: '0',
      KCODER_STUDIO_AUTH_TOKEN: loginToken,
      KCODER_STUDIO_PUBLIC_ORIGINS: origin,
      KCODER_STUDIO_SERVERS_STORE: serverStore,
      KCODER_STUDIO_SERVERS: JSON.stringify([{
        id: 'local',
        label,
        transport: 'local',
        workspace,
      }]),
      KCODER_STUDIO_MOCK: '1',
      KCODER_STUDIO_WORKSPACE: workspace,
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const gateway = { id, label, loginToken, workspace, stateDir, child, baseUrl: null, port: null };

  try {
    const address = await new Promise((resolveAddress, rejectAddress) => {
      let output = '';
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => finish(rejectAddress, new Error('isolated Studio Gateway was not ready within 10 seconds')), 10_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output = `${output}${chunk}`.slice(-2048);
        const match = output.match(/KCoder Studio: http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) finish(resolveAddress, { baseUrl: `http://127.0.0.1:${match[1]}`, port: Number(match[1]) });
      });
      child.once('error', () => finish(rejectAddress, new Error('isolated Studio Gateway process failed')));
      child.once('exit', () => finish(rejectAddress, new Error('isolated Studio Gateway exited before readiness')));
    });
    gateway.baseUrl = address.baseUrl;
    gateway.port = address.port;
    return gateway;
  } catch (error) {
    await stopGateway(gateway);
    throw error;
  }
}

function routePath(id, path) {
  return `/g/${id}${path.startsWith('/') ? path : `/${path}`}`;
}

function requestRelay(fixture, {
  id,
  path,
  method = 'GET',
  accessToken,
  pairingToken,
  timeoutMs = 5000,
}) {
  const headers = { host: authority, origin };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (pairingToken) headers['content-type'] = 'application/json';
  const body = pairingToken ? JSON.stringify({ token: pairingToken }) : undefined;
  return new Promise(resolveResponse => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolveResponse(value);
    };
    const outgoing = request({
      host: '127.0.0.1',
      port: fixture.relay.proxyPort,
      method,
      path: routePath(id, path),
      headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => finish({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.once('aborted', () => finish({ status: 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.once('error', () => finish({ status: 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy());
    outgoing.once('error', () => finish({ status: 0, headers: {}, body: Buffer.alloc(0) }));
    outgoing.end(body);
  });
}

function rpcClient(socket) {
  let nextId = 1;
  return {
    socket,
    request(method, params = {}) {
      const id = nextId++;
      const result = new Promise((resolveResult, rejectResult) => {
        const timer = setTimeout(() => {
          socket.removeListener('message', receive);
          rejectResult(new Error('isolated Studio RPC timed out'));
        }, 5000);
        const receive = raw => {
          let message;
          try { message = JSON.parse(raw.toString()); }
          catch {
            clearTimeout(timer);
            socket.removeListener('message', receive);
            rejectResult(new Error('isolated Studio Gateway returned invalid JSON-RPC'));
            return;
          }
          if (message.id !== id) return;
          clearTimeout(timer);
          socket.removeListener('message', receive);
          if (message.error) rejectResult(new Error('isolated Studio RPC returned an error'));
          else resolveResult(message.result);
        };
        socket.on('message', receive);
      });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      return result;
    },
  };
}

function openRpc(fixture, id, session, { web = false, accessToken = session.accessToken } = {}) {
  const query = new URLSearchParams({ token: session.rpcToken, server: 'local', channel: 'runtime' });
  const ws = new WebSocket(`ws://127.0.0.1:${fixture.relay.proxyPort}${routePath(id, `/rpc?${query}`)}`, ...(web
    ? [['kcoder-studio', `kcoder-session.${accessToken}`], {
      headers: { host: authority, origin },
      handshakeTimeout: 5000,
      maxPayload: 256 * 1024,
      perMessageDeflate: false,
    }]
    : [{
      headers: { host: authority, origin, authorization: `Bearer ${accessToken}` },
      handshakeTimeout: 5000,
      maxPayload: 256 * 1024,
      perMessageDeflate: false,
    }]));
  fixture.sockets.add(ws);
  ws.on('error', () => {});
  return withTimeout(new Promise(resolveOutcome => {
    let settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      resolveOutcome(outcome);
    };
    ws.once('open', () => finish({ status: 101, rpc: rpcClient(ws), ws }));
    ws.once('unexpected-response', (_request, response) => {
      const status = response.statusCode || 0;
      response.resume();
      finish({ status, rpc: null, ws: null });
    });
    ws.once('error', () => finish({ status: 0, rpc: null, ws: null }));
  }), 6000, 'Studio Gateway WebSocket handshake timed out');
}

async function exchangeMobileSession(fixture, id, loginToken = fixture.gateways.get(id).loginToken) {
  const response = await requestRelay(fixture, {
    id,
    method: 'POST',
    path: '/api/mobile/session',
    pairingToken: loginToken,
  });
  if (response.status !== 200) return { status: response.status, session: null };
  let session;
  try { session = JSON.parse(response.body.toString('utf8')); }
  catch { throw new Error('Studio Gateway returned an invalid mobile session response'); }
  assert.equal(typeof session.accessToken, 'string', 'Studio Gateway returns an access token');
  assert.equal(typeof session.rpcToken, 'string', 'Studio Gateway returns an RPC token');
  return { status: response.status, session };
}

async function createFixture(t) {
  const fixture = {
    stateDirs: new Map(),
    gateways: new Map(),
    clients: new Set(),
    sockets: new Set(),
    relay: null,
  };
  t.after(async () => {
    for (const client of fixture.clients) client.close();
    for (const socket of fixture.sockets) socket.terminate();
    if (fixture.relay) await fixture.relay.close();
    await Promise.all([...fixture.gateways.values()].map(stopGateway));
    await Promise.all([...fixture.stateDirs.values()].map(path => rm(path, { recursive: true, force: true })));
  });
  for (const id of ids) {
    fixture.stateDirs.set(id, await mkdtemp(join(tmpdir(), `kcoder-relay-studio-${id}-`)));
  }

  const gatewayConfigs = ids.map(id => {
    const label = `Isolated Studio Gateway ${id.toUpperCase()}`;
    const loginToken = token();
    const secret = token();
    fixture.gateways.set(id, { id, label, loginToken, secret, stateDir: fixture.stateDirs.get(id), baseUrl: null, port: null });
    return { id, label, loginToken, secret };
  });
  const gatewayStarts = await Promise.allSettled(gatewayConfigs.map(async config => {
    const gateway = await startGateway({
      stateDir: fixture.stateDirs.get(config.id),
      id: config.id,
      label: config.label,
      loginToken: config.loginToken,
    });
    fixture.gateways.set(gateway.id, { ...fixture.gateways.get(gateway.id), ...gateway });
  }));
  const failedStart = gatewayStarts.find(result => result.status === 'rejected');
  if (failedStart) throw failedStart.reason;

  fixture.relay = await startRelay({
    gateways: gatewayConfigs.map(({ id, loginToken, secret }) => ({ id, secret, pairingToken: loginToken })),
    sharedHosts: [authority],
    controlPort: 0,
    proxyPort: 0,
    connectTimeout: 1000,
  });

  async function connectClient(id) {
    const gateway = fixture.gateways.get(id);
    const options = {
      url: `http://127.0.0.1:${fixture.relay.controlPort}`,
      secret: gateway.secret,
      gateway: gateway.baseUrl,
      allowInsecure: true,
      retryMs: 35,
    };
    if (id === 'a') options.device = id;
    else options.gatewayId = id;
    const online = new Promise(resolveOnline => {
      options.onOnline = resolveOnline;
    });
    const client = startClient(options);
    fixture.clients.add(client);
    await withTimeout(online, 10_000, 'isolated reverse Gateway client was not online within 10 seconds');
  }
  await Promise.all(ids.map(connectClient));
  return fixture;
}

function parseJson(response, message) {
  try { return JSON.parse(response.body.toString('utf8')); }
  catch { throw new Error(message); }
}

function waitForSocketClose(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return withTimeout(once(socket, 'close'), 7000, 'revoked Gateway WebSocket did not close');
}

test('real Studio Gateways stay isolated through multi-Gateway Relay authentication and RPC', { timeout: 60_000 }, async t => {
  const fixture = await createFixture(t);

  const paired = new Map();
  for (const id of ids) {
    const result = await exchangeMobileSession(fixture, id);
    assert.equal(result.status, 200, `Gateway ${id.toUpperCase()} mobile session exchange succeeds`);
    paired.set(id, result.session);
  }

  for (const id of ids) {
    const response = await requestRelay(fixture, {
      id,
      path: '/api/servers',
      accessToken: paired.get(id).accessToken,
    });
    assert.equal(response.status, 200, `Gateway ${id.toUpperCase()} accepts its mobile Bearer session`);
    const servers = parseJson(response, 'Gateway returned an invalid servers response').servers;
    assert.ok(Array.isArray(servers), 'Gateway servers response is an array');
    assert.ok(servers.some(server => server.label === fixture.gateways.get(id).label),
      `Gateway ${id.toUpperCase()} returns its own isolated server label`);
    assert.ok(!servers.some(server => server.label === fixture.gateways.get(id === 'a' ? 'b' : 'a').label),
      'Gateway server labels do not cross tenant boundaries');
  }

  const wrongPairing = await exchangeMobileSession(fixture, 'a', fixture.gateways.get('b').loginToken);
  assert.equal(wrongPairing.status, 401, 'Gateway B login token cannot create a Gateway A session');
  const wrongBearer = await requestRelay(fixture, {
    id: 'a',
    path: '/api/servers',
    accessToken: paired.get('b').accessToken,
  });
  assert.equal(wrongBearer.status, 401, 'Gateway B access token cannot read Gateway A servers');

  const rpc = new Map();
  for (const id of ids) {
    for (const web of [false, true]) {
      const opened = await openRpc(fixture, id, paired.get(id), { web });
      assert.equal(opened.status, 101, `Gateway ${id.toUpperCase()} ${web ? 'Mobile Web' : 'Bearer'} RPC opens`);
      const initialized = await opened.rpc.request('initialize', {
        protocolVersion: '2026-07-27',
        clientInfo: { name: `multigateway-studio-${id}-${web ? 'web' : 'native'}`, version: '1' },
      });
      assert.equal(initialized.protocolVersion, '2026-07-27', 'Gateway RPC initialize succeeds');
      const threads = await opened.rpc.request('thread/list', {});
      assert.ok(Array.isArray(threads.threads), 'Gateway RPC thread/list returns a thread array');
      rpc.set(`${id}-${web ? 'web' : 'native'}`, opened.rpc);
    }
  }

  const crossRpc = await openRpc(fixture, 'b', paired.get('b'), { accessToken: paired.get('a').accessToken });
  assert.equal(crossRpc.status, 401, 'Gateway A access token cannot open Gateway B RPC');

  const aSockets = [rpc.get('a-native').socket, rpc.get('a-web').socket];
  assert.ok(aSockets.every(socket => socket.readyState === WebSocket.OPEN), 'A RPC owners remain open before logout');
  const aClosed = aSockets.map(waitForSocketClose);
  const logoutA = await requestRelay(fixture, {
    id: 'a',
    method: 'DELETE',
    path: '/api/mobile/session',
    accessToken: paired.get('a').accessToken,
  });
  assert.equal(logoutA.status, 204, 'Gateway A session logout completes through its routed tenant path');
  await Promise.all(aClosed);
  assert.ok(aSockets.every(socket => socket.readyState === WebSocket.CLOSED), 'A logout closes both A RPC owners');

  const revokedA = await requestRelay(fixture, {
    id: 'a', path: '/api/servers', accessToken: paired.get('a').accessToken,
  });
  assert.equal(revokedA.status, 401, 'Gateway A access is revoked after logout');
  const survivingB = await requestRelay(fixture, {
    id: 'b', path: '/api/servers', accessToken: paired.get('b').accessToken,
  });
  assert.equal(survivingB.status, 200, 'Gateway B session survives Gateway A logout');
  for (const key of ['b-native', 'b-web']) {
    const owner = rpc.get(key);
    assert.ok(owner.socket.readyState === WebSocket.OPEN, 'Gateway B RPC owners stay connected');
    const threads = await owner.request('thread/list', {});
    assert.ok(Array.isArray(threads.threads), 'Gateway B RPC remains usable after Gateway A logout');
  }
});
