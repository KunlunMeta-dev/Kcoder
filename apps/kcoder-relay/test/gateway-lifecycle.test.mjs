// Model-independent integration tests for the real Studio Gateway session and
// WebSocket boundary through isolated Relay and reverse-client processes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request, Agent } from 'node:http';
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
const publicAuthority = 'relay-fixture.test:8451';
const publicOrigin = `http://${publicAuthority}`;

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  throw new Error('timed out waiting for isolated fixture state');
}

async function startGateway({ port = 0, stateDir, loginToken }) {
  const serverStore = join(stateDir, 'servers.json');
  const child = spawn(process.execPath, ['dev-server.mjs'], {
    cwd: studioRoot,
    env: {
      PATH: process.env.PATH || '',
      HOME: stateDir,
      TMPDIR: stateDir,
      LANG: process.env.LANG || 'C',
      KCODER_STUDIO_HOST: '127.0.0.1',
      KCODER_STUDIO_PORT: String(port),
      KCODER_STUDIO_AUTH_TOKEN: loginToken,
      KCODER_STUDIO_PUBLIC_ORIGINS: publicOrigin,
      KCODER_STUDIO_SERVERS_STORE: serverStore,
      KCODER_STUDIO_SERVERS: JSON.stringify([{
        id: 'local',
        label: 'Relay lifecycle fixture',
        transport: 'local',
        workspace: repoRoot,
      }]),
      KCODER_STUDIO_MOCK: '1',
      KCODER_STUDIO_WORKSPACE: repoRoot,
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });

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
      const timer = setTimeout(() => finish(rejectAddress, new Error('isolated Gateway did not become ready')), 8000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output = `${output}${chunk}`.slice(-2048);
        const match = output.match(/KCoder Studio: http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) finish(resolveAddress, { baseUrl: `http://127.0.0.1:${match[1]}`, port: Number(match[1]) });
      });
      child.once('error', () => finish(rejectAddress, new Error('isolated Gateway process failed')));
      child.once('exit', () => finish(rejectAddress, new Error('isolated Gateway exited before readiness')));
    });
    return { child, ...address };
  } catch (error) {
    await stopGateway({ child });
    throw error;
  }
}

async function stopGateway(gateway) {
  if (!gateway?.child || gateway.child.exitCode !== null || gateway.child.signalCode !== null) return;
  const closed = once(gateway.child, 'close');
  gateway.child.kill('SIGTERM');
  let timer;
  const exited = await Promise.race([
    closed.then(() => true),
    new Promise(resolveExit => { timer = setTimeout(() => resolveExit(false), 3000); }),
  ]);
  clearTimeout(timer);
  if (exited) return;
  const forceClosed = once(gateway.child, 'close');
  gateway.child.kill('SIGKILL');
  await forceClosed;
}

async function createFixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'kcoder-relay-gateway-lifecycle-'));
  const loginToken = randomBytes(32).toString('hex');
  const relaySecret = randomBytes(32).toString('hex');
  const device = `fixture-${randomBytes(4).toString('hex')}`;
  let gateway;
  let relay;
  const clients = new Set();
  const sockets = new Set();
  const agents = new Set();
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const agent of agents) agent.destroy();
    for (const socket of sockets) socket.terminate();
    for (const client of clients) client.close();
    if (relay) await relay.close();
    await stopGateway(gateway);
    await rm(stateDir, { recursive: true, force: true });
  };
  t.after(cleanup);

  try {
    gateway = await startGateway({ stateDir, loginToken });
    relay = await startRelay({
      secret: relaySecret,
      device,
      controlPort: 0,
      proxyPort: 0,
      connectTimeout: 500,
      maxConnections: 16,
    });

    async function startReverseClient() {
      let client;
      await Promise.race([
        new Promise(resolveOnline => {
          client = startClient({
            url: `http://127.0.0.1:${relay.controlPort}`,
            secret: relaySecret,
            device,
            gateway: `http://127.0.0.1:${gateway.port}`,
            allowInsecure: true,
            retryMs: 20,
            onOnline: resolveOnline,
          });
          clients.add(client);
        }),
        delay(5000).then(() => { throw new Error('isolated reverse client did not become online'); }),
      ]);
      return client;
    }

    async function proxyRequest({ method = 'GET', path = '/', body, accessToken, agent = false } = {}) {
      const headers = {
        host: publicAuthority,
        origin: publicOrigin,
        connection: agent ? 'keep-alive' : 'close',
      };
      if (accessToken) headers.authorization = `Bearer ${accessToken}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      return new Promise((resolveResponse, rejectResponse) => {
        const outgoing = request({
          host: '127.0.0.1',
          port: relay.proxyPort,
          method,
          path,
          headers,
          agent,
        }, response => {
          const chunks = [];
          let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > 1024 * 1024) {
              outgoing.destroy(new Error('fixture response exceeded its bound'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => resolveResponse({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          response.on('error', rejectResponse);
        });
        outgoing.setTimeout(5000, () => outgoing.destroy(new Error('isolated request timed out')));
        outgoing.once('error', rejectResponse);
        outgoing.end(body);
      });
    }

    async function exchangeSession(agent = false) {
      const response = await proxyRequest({
        method: 'POST',
        path: '/api/mobile/session',
        body: JSON.stringify({ token: loginToken }),
        agent,
      });
      assert.equal(response.status, 200, 'the isolated Gateway should exchange a mobile token');
      const session = JSON.parse(response.body);
      assert.equal(session.rpcToken, 'cookie-auth');
      return session;
    }

    function openRuntime(accessToken) {
      const url = `ws://127.0.0.1:${relay.proxyPort}/rpc?token=cookie-auth&server=local&channel=runtime`;
      const socket = new WebSocket(url, {
        headers: {
          host: publicAuthority,
          origin: publicOrigin,
          authorization: `Bearer ${accessToken}`,
        },
        handshakeTimeout: 4000,
        maxPayload: 256 * 1024,
        perMessageDeflate: false,
      });
      socket.on('error', () => {});
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      return new Promise((resolveSocket, rejectSocket) => {
        const timer = setTimeout(() => {
          socket.terminate();
          rejectSocket(new Error('isolated runtime WebSocket did not open'));
        }, 5000);
        socket.once('open', () => {
          clearTimeout(timer);
          resolveSocket(createRpcClient(socket));
        });
        socket.once('error', () => {
          clearTimeout(timer);
          rejectSocket(new Error('isolated runtime WebSocket failed'));
        });
      });
    }

    async function health() {
      const response = await new Promise((resolveResponse, rejectResponse) => {
        const outgoing = request({ host: '127.0.0.1', port: relay.controlPort, path: '/_relay/health' }, incoming => {
          const chunks = [];
          incoming.on('data', chunk => chunks.push(chunk));
          incoming.on('end', () => resolveResponse({ status: incoming.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          incoming.on('error', rejectResponse);
        });
        outgoing.setTimeout(2000, () => outgoing.destroy(new Error('Relay health probe timed out')));
        outgoing.once('error', rejectResponse);
        outgoing.end();
      });
      assert.equal(response.status, 200);
      return JSON.parse(response.body);
    }

    async function waitForHealth(predicate) {
      return waitFor(async () => {
        const current = await health();
        return predicate(current) ? current : null;
      });
    }

    function createAgent() {
      const agent = new Agent({ keepAlive: true, maxSockets: 4 });
      agents.add(agent);
      return agent;
    }

    function closeSocket(rpc) {
      const socket = rpc?.socket;
      if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise(resolveClose => {
        const timer = setTimeout(() => {
          socket.terminate();
          resolveClose();
        }, 1500);
        socket.once('close', () => {
          clearTimeout(timer);
          resolveClose();
        });
        if (socket.readyState === WebSocket.OPEN) socket.close();
        else socket.terminate();
      });
    }

    const client = await startReverseClient();
    return {
      get gateway() { return gateway; },
      get relay() { return relay; },
      loginToken,
      clients,
      agents,
      startReverseClient,
      proxyRequest,
      exchangeSession,
      openRuntime,
      health,
      waitForHealth,
      createAgent,
      closeSocket,
      async stopGateway() { await stopGateway(gateway); },
      async restartGateway(port = gateway.port) { gateway = await startGateway({ port, stateDir, loginToken }); return gateway; },
      async stopReverseClient() { client.close(); clients.delete(client); },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function createRpcClient(socket) {
  let nextId = 1;
  return {
    socket,
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolveResult, rejectResult) => {
        const timer = setTimeout(() => {
          socket.removeListener('message', receive);
          rejectResult(new Error('isolated runtime RPC timed out'));
        }, 5000);
        const receive = raw => {
          let message;
          try { message = JSON.parse(raw.toString()); }
          catch {
            clearTimeout(timer);
            socket.removeListener('message', receive);
            rejectResult(new Error('isolated runtime returned invalid JSON-RPC'));
            return;
          }
          if (message.id !== id) return;
          clearTimeout(timer);
          socket.removeListener('message', receive);
          if (message.error) rejectResult(new Error('isolated runtime RPC returned an error'));
          else resolveResult(message.result);
        };
        socket.on('message', receive);
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    },
  };
}

test('local Relay preserves mobile session DELETE after real Gateway WSS initialize and thread/list', async t => {
  const fixture = await createFixture(t);
  const agent = fixture.createAgent();
  const session = await fixture.exchangeSession(agent);
  const servers = await fixture.proxyRequest({ path: '/api/servers', accessToken: session.accessToken, agent });
  assert.equal(servers.status, 200);

  const rpc = await fixture.openRuntime(session.accessToken);
  const initialized = await rpc.request('initialize', {
    protocolVersion: '2026-07-27',
    clientInfo: { name: 'relay-lifecycle-local-probe', version: '1' },
  });
  assert.equal(initialized.protocolVersion, '2026-07-27');
  const threads = await rpc.request('thread/list', {});
  assert.ok(Array.isArray(threads.threads));
  await fixture.closeSocket(rpc);

  const revoked = await fixture.proxyRequest({
    method: 'DELETE',
    path: '/api/mobile/session',
    accessToken: session.accessToken,
    agent,
  });
  assert.equal(revoked.status, 204, 'session revocation must survive the completed WSS cleanup path');
  const denied = await fixture.proxyRequest({ path: '/api/servers', accessToken: session.accessToken, agent });
  assert.equal(denied.status, 401);
});

test('Caddy-like keep-alive DELETE revokes an initialized WSS owner without truncating its response', async t => {
  const fixture = await createFixture(t);
  const agent = fixture.createAgent();
  const session = await fixture.exchangeSession(agent);
  const servers = await fixture.proxyRequest({ path: '/api/servers', accessToken: session.accessToken, agent });
  assert.equal(servers.status, 200);

  const rpc = await fixture.openRuntime(session.accessToken);
  const initialized = await rpc.request('initialize', {
    protocolVersion: '2026-07-27',
    clientInfo: { name: 'relay-delete-close-race-probe', version: '1' },
  });
  assert.equal(initialized.protocolVersion, '2026-07-27');
  const threads = await rpc.request('thread/list', {});
  assert.ok(Array.isArray(threads.threads));
  await fixture.waitForHealth(value => value.connections === 2 && value.pending === 0);

  const closed = once(rpc.socket, 'close');
  const revokedPromise = fixture.proxyRequest({
    method: 'DELETE',
    path: '/api/mobile/session',
    accessToken: session.accessToken,
    agent,
  });
  const [revoked] = await Promise.all([
    revokedPromise,
    Promise.race([
      closed,
      delay(3000).then(() => { throw new Error('Gateway did not close the revoked WSS owner'); }),
    ]),
  ]);
  assert.equal(revoked.status, 204, 'Caddy-like keep-alive DELETE must receive the complete 204 response');
  const denied = await fixture.proxyRequest({ path: '/api/servers', accessToken: session.accessToken, agent });
  assert.equal(denied.status, 401);

  agent.destroy();
  await fixture.waitForHealth(value => value.connections === 0 && value.pending === 0);
});

test('two mobile sessions keep independent WSS owners when one session is revoked', async t => {
  const fixture = await createFixture(t);
  const agent = fixture.createAgent();
  const first = await fixture.exchangeSession(agent);
  const second = await fixture.exchangeSession(agent);
  const firstA = await fixture.openRuntime(first.accessToken);
  const firstB = await fixture.openRuntime(first.accessToken);
  const secondRpc = await fixture.openRuntime(second.accessToken);
  await Promise.all([
    firstA.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'relay-owner-a', version: '1' } }),
    firstB.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'relay-owner-b', version: '1' } }),
    secondRpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'relay-owner-c', version: '1' } }),
  ]);

  const firstClosedA = once(firstA.socket, 'close');
  const firstClosedB = once(firstB.socket, 'close');
  const revoked = await fixture.proxyRequest({
    method: 'DELETE',
    path: '/api/mobile/session',
    accessToken: first.accessToken,
    agent,
  });
  assert.equal(revoked.status, 204);
  await Promise.all([firstClosedA, firstClosedB]);
  assert.equal(secondRpc.socket.readyState, WebSocket.OPEN);
  const secondThreads = await secondRpc.request('thread/list', {});
  assert.ok(Array.isArray(secondThreads.threads));

  const finalDelete = await fixture.proxyRequest({
    method: 'DELETE',
    path: '/api/mobile/session',
    accessToken: second.accessToken,
    agent,
  });
  assert.equal(finalDelete.status, 204);
  await fixture.closeSocket(secondRpc);
});

test('Gateway readiness loss leaves no Relay pending socket and recovers on the same target port', async t => {
  const fixture = await createFixture(t);
  const port = fixture.gateway.port;
  await fixture.stopGateway();
  const down = await fixture.health();
  assert.equal(down.online, true, 'control-channel liveness is distinct from target Gateway readiness');

  let requestFailed = false;
  try {
    await fixture.proxyRequest({
      method: 'POST',
      path: '/api/mobile/session',
      body: JSON.stringify({ token: fixture.loginToken }),
    });
  } catch {
    requestFailed = true;
  }
  assert.equal(requestFailed, true, 'a disconnected local Gateway must not produce a false mobile session');
  await fixture.waitForHealth(value => value.pending === 0 && value.connections === 0);

  await fixture.restartGateway(port);
  const session = await fixture.exchangeSession();
  assert.ok(session.accessToken);
  const ready = await fixture.health();
  assert.equal(ready.online, true);
  assert.equal(ready.pending, 0);
});

test('closing the reverse client releases live Relay tunnels before reconnect', async t => {
  const fixture = await createFixture(t);
  const agent = fixture.createAgent();
  const session = await fixture.exchangeSession(agent);
  const rpc = await fixture.openRuntime(session.accessToken);
  await rpc.request('initialize', {
    protocolVersion: '2026-07-27',
    clientInfo: { name: 'relay-cancellation-probe', version: '1' },
  });
  await fixture.waitForHealth(value => value.connections === 2 && value.pending === 0);
  agent.destroy();
  await fixture.waitForHealth(value => value.connections === 1 && value.pending === 0);
  const closed = once(rpc.socket, 'close');
  await fixture.stopReverseClient();
  await closed;
  const idle = await fixture.waitForHealth(value => value.connections === 0 && value.pending === 0);
  assert.equal(idle.online, false);

  const offline = await fixture.proxyRequest({ path: '/api/servers', accessToken: session.accessToken });
  assert.equal(offline.status, 503);
  const reconnected = await fixture.startReverseClient();
  assert.ok(reconnected);
  const afterReconnect = await fixture.proxyRequest({ path: '/api/servers', accessToken: session.accessToken });
  assert.equal(afterReconnect.status, 200);
});
