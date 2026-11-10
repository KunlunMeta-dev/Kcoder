import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect as connectTcp } from 'node:net';
import { RunContext } from './run-context.mjs';
import { closeOwnedLocalRelayResources, startLocalRelay } from './local-relay.mjs';

const relayRequire = createRequire(new URL('../../../kcoder-relay/package.json', import.meta.url));
const WebSocket = relayRequire('ws');
const { WebSocketServer } = WebSocket;

test('local Relay cleanup attempts both owned resources and preserves both failures', async () => {
  const attempted = [];
  const unownedGateway = { open: true };
  const clientFailure = new Error('synthetic owned client stop failure');
  const relayFailure = new Error('synthetic owned Relay stop failure');
  await assert.rejects(
    closeOwnedLocalRelayResources(
      async () => { attempted.push('owned-client'); throw clientFailure; },
      async () => { attempted.push('owned-relay'); throw relayFailure; },
    ),
    error => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(error.errors, [clientFailure, relayFailure]);
      return true;
    },
  );
  assert.deepEqual(attempted, ['owned-client', 'owned-relay']);
  assert.equal(unownedGateway.open, true);
});

test('local Relay registers one owned Gateway, routes loopback HTTP/WS without TLS, and closes only its resources', async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: 'local-relay-owned-gateway-routing',
    tier: 'full-integration',
    modelPolicy: 'local Relay registration and fixture loopback HTTP/WS routing without TLS; no Browser, Provider, or model request',
    cleanupTimeoutMs: 10_000,
  });
  let failure;
  let gatewayFixture;
  let localRelay;
  let result = null;
  const ownedPorts = [];
  context.addCleanup('verify all local Relay fixture listeners are closed', async () => {
    for (const port of ownedPorts) await assertPortClosed(port);
  });

  try {
    const pairingToken = randomBytes(32).toString('base64url');
    context.registerSecret(pairingToken);
    gatewayFixture = await startFixtureGateway(context, pairingToken);
    ownedPorts.push(gatewayFixture.gateway.port);
    localRelay = await startLocalRelay(context);
    ownedPorts.push(localRelay.proxyPort, localRelay.controlPort);

    await assert.rejects(localRelay.connectGateway({
      baseUrl: 'http://127.0.0.1:4173',
      port: 4173,
      authToken: pairingToken,
    }), /RunContext-owned loopback origin/);

    const mounted = await localRelay.connectGateway(gatewayFixture.gateway);
    assert.match(mounted.gatewayId, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(mounted.origin, localRelay.origin);
    assert.equal(mounted.gatewayBaseUrl, `${localRelay.origin}/g/${mounted.gatewayId}`);
    assert.equal(mounted.mobileEntryUrl, `${mounted.gatewayBaseUrl}/mobile-entry`);
    assert.equal(mounted.mobileUrl, `${mounted.gatewayBaseUrl}/mobile/`);
    assert.equal(mounted.isOnline(), true);
    await assert.rejects(localRelay.connectGateway(gatewayFixture.gateway), /single-attempt/);

    const stateMode = (await lstat(context.stateDir)).mode & 0o777;
    const storeStat = await lstat(context.pathInState('local-relay-registration-store.json'));
    const identityStat = await lstat(context.pathInState('local-relay-client-identity.json'));
    assert.equal(stateMode, 0o700);
    assert.equal(storeStat.isFile(), true);
    assert.equal(identityStat.isFile(), true);
    assert.equal(storeStat.mode & 0o777, 0o600);
    assert.equal(identityStat.mode & 0o777, 0o600);

    const routed = await fetch(`${mounted.gatewayBaseUrl}/fixture?case=http`);
    assert.equal(routed.status, 200);
    assert.deepEqual(await routed.json(), { path: '/fixture' });
    assert.equal(gatewayFixture.requests.at(-1).path, '/fixture?case=http');

    const entry = await fetch(mounted.mobileEntryUrl);
    assert.equal(entry.status, 200);
    assert.deepEqual(await entry.json(), { path: '/mobile-entry' });
    const mountRequest = gatewayFixture.requests.at(-1);
    assert.equal(mountRequest.path, '/mobile-entry');
    assert.equal(mountRequest.mount, `/g/${mounted.gatewayId}`);
    const expectedProof = createHmac('sha256', pairingToken)
      .update(JSON.stringify(['kcoder-mobile-mount-v1', new URL(localRelay.origin).host, `/g/${mounted.gatewayId}`]))
      .digest('hex');
    assert.equal(mountRequest.proof === expectedProof, true, 'Relay must sign the selected Gateway mount for this exact host');

    assert.equal(await exchangeWebSocket(`${localRelay.origin.replace(/^http:/, 'ws:')}/g/${mounted.gatewayId}/fixture-ws`, 'probe'), 'fixture:probe');
    const diagnostics = localRelay.diagnostics();
    assert.ok(diagnostics.length <= 2_000);
    assert.equal(localRelay.droppedDiagnosticCount(), 0);
    assert.ok(diagnostics.some(record => record.event === 'control_open'));
    assert.ok(diagnostics.some(record => record.event === 'data_open'));
    assert.ok(diagnostics.some(record => record.event === 'local_connect'));
    assert.ok(diagnostics.every(record => record.correlation === undefined || /^[a-f0-9]{64}$/.test(record.correlation)));

    await localRelay.close();
    assert.equal(localRelay.isOnline(), false);
    await assertPortClosed(localRelay.proxyPort);
    await assertPortClosed(localRelay.controlPort);
    const gatewayStillOwned = await fetch(`${gatewayFixture.gateway.baseUrl}/fixture?case=still-open`);
    assert.equal(gatewayStillOwned.status, 200);
    await assert.rejects(fetch(`${mounted.gatewayBaseUrl}/fixture?case=after-close`));

    result = {
      scope: 'local Relay registration, exact shared-host Gateway routing, Mobile mount proof, and loopback WS transport without TLS',
      gatewayIdentity: 'one RunContext-owned registration',
      httpRoutes: 2,
      websocketEcho: true,
      privateStateModes: { state: '0700', registrationStore: '0600', clientIdentity: '0600' },
      diagnostics: diagnostics.map(record => record.event),
      diagnosticsDropped: localRelay.droppedDiagnosticCount(),
      relayGetPoolQueueMeasurement: 'not exposed by the current Relay API; not measured',
      externalServicesOrProviderCalls: 0,
    };
  } catch (error) {
    failure = error;
  }

  try {
    await context.finish(failure ? 'failed' : 'passed', result, failure);
  } catch (cleanupError) {
    failure ??= cleanupError;
  }
  if (failure) throw failure;
  await assert.rejects(lstat(context.stateDir), { code: 'ENOENT' });
});

async function startFixtureGateway(context, pairingToken) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    requests.push({
      path: `${url.pathname}${url.search}`,
      mount: request.headers['x-kcoder-mobile-mount'] || null,
      proof: request.headers['x-kcoder-mobile-mount-proof'] || null,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ path: url.pathname }));
  });
  const sockets = new Set();
  const wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  wsServer.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('message', message => socket.send(`fixture:${message.toString()}`));
  });
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url, 'http://fixture.invalid').pathname !== '/fixture-ws') {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, upgraded => wsServer.emit('connection', upgraded, request));
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  context.registerPort('local-relay-fixture-gateway', port);
  context.addCleanup('close local Relay fixture Gateway', async () => {
    for (const socket of sockets) socket.terminate();
    const stopped = new Promise(resolveClose => server.close(resolveClose));
    server.closeAllConnections?.();
    await stopped;
    await new Promise(resolveClose => wsServer.close(resolveClose));
  });
  return {
    requests,
    gateway: {
      baseUrl: `http://127.0.0.1:${port}`,
      port,
      authToken: pairingToken,
    },
  };
}

async function exchangeWebSocket(url, message) {
  const socket = new WebSocket(url);
  let timeout;
  try {
    await once(socket, 'open');
    const reply = once(socket, 'message').then(([value]) => value.toString());
    socket.send(message);
    return await Promise.race([
      reply,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Local Relay WebSocket fixture timed out')), 5_000); }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    if (socket.readyState !== WebSocket.CLOSED) await once(socket, 'close').catch(() => {});
  }
}

async function assertPortClosed(port) {
  await new Promise((resolve, reject) => {
    const socket = connectTcp({ host: '127.0.0.1', port });
    socket.setTimeout(1_000);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('RunContext-owned local listener remained open after cleanup'));
    });
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(new Error('Could not verify an owned local listener was closed'));
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Timed out while verifying an owned local listener was closed'));
    });
  });
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    const onEvent = (...args) => { emitter.removeListener('error', onError); resolve(args); };
    const onError = error => { emitter.removeListener(event, onEvent); reject(error); };
    emitter.once(event, onEvent);
    emitter.once('error', onError);
  });
}
