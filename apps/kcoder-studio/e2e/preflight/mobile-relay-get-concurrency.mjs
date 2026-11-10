import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Agent, createServer, request as httpRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
import { runE2E, waitFor } from '../harness/run-context.mjs';
import { startLocalRelay } from '../harness/local-relay.mjs';

const LOOPBACK = '127.0.0.1';
const HOLD_DELAYS_MS = [0, 300, 600, 1_000];
const SAMPLES_PER_DELAY = 2;
const GATE_OBSERVATION_MS = 50;
const REQUEST_TIMEOUT_MS = 10_000;
const GATE_PILOT_ONLY = process.argv.includes('--gate-pilot-only');
const DIRECT_PILOT_ONLY = process.argv.includes('--direct-pilot-only');
const RESPONSE_BODY = Buffer.from(JSON.stringify({ ok: true, rows: [{ id: 'fixture-row', value: 'constant' }] }));

await runE2E(import.meta.url, {
  testId: DIRECT_PILOT_ONLY
    ? 'mobile-relay-get-concurrency-direct-pilot'
    : GATE_PILOT_ONLY ? 'mobile-relay-get-concurrency-gate-pilot' : 'mobile-relay-get-concurrency-preflight',
  tier: 'full-integration',
  modelPolicy: 'model-independent loopback Relay GET pool gate and matched fixture timing probe; no TLS, Browser, Expo, Provider, or real Studio Gateway',
  cleanupTimeoutMs: 15_000,
}, async context => {
  const runStartedAt = performance.now();
  const fixture = await startFixture(context);
  const localRelay = await startLocalRelay(context, {
    label: 'mobile-get-concurrency-relay',
    connectTimeoutMs: 5_000,
    onlineTimeoutMs: 5_000,
  });
  const mounted = await localRelay.connectGateway(fixture.gateway);
  assert.equal(mounted.isOnline(), true, 'the single fixture Gateway control channel must be online before measurement');
  const connectionSetup = {
    registeredFixtureGatewayClients: 1,
    controlChannelOnlineAtMeasurementStart: mounted.isOnline(),
    explicitGetPoolPrewarmRequestsPerGrant: 0,
    measuredRelayPhaseStartsAfterGrantExchange: true,
    dataOpenCounts: 'cumulative open events; phase deltas count new opens and do not represent currently idle sockets',
  };
  const agent = new Agent({ keepAlive: false, maxSockets: 3, maxTotalSockets: 6 });
  const activeRequests = new Set();
  context.addCleanup('close owned probe requests and HTTP agent', async () => {
    fixture.releasePendingResponses();
    const outstanding = [...activeRequests];
    for (const handle of outstanding) handle.abort();
    agent.destroy();
    await Promise.allSettled(outstanding.map(handle => handle.response));
  });

  if (DIRECT_PILOT_ONLY) {
    const grant = await createGrant({ context, fixture, mounted, agent, activeRequests });
    const dataOpenBefore = completeDataOpenCount(localRelay);
    const directPilot = await runAutomaticPhase({
      fixture, mounted, agent, activeRequests, accessToken: grant.accessToken,
      route: 'direct', holdMs: 300, runStartedAt, label: 'direct-pilot-300ms',
    });
    const dataOpenAfter = completeDataOpenCount(localRelay);
    await revokeGrant({ mounted, agent, activeRequests, accessToken: grant.accessToken });
    const diagnosticsDropped = localRelay.droppedDiagnosticCount();
    assert.equal(diagnosticsDropped, 0, 'direct pilot requires a complete local Relay diagnostic trace');
    assert.equal(dataOpenBefore !== null && dataOpenAfter !== null, true, 'direct pilot data channel counts must be available');
    assert.equal(directPilot.fixtureMaxConcurrentRequests, 3, 'direct fixture must hold all three GETs concurrently');
    assert.equal(directPilot.endpointThirdReceivedBeforeFirstCompletion, true,
      'all direct GETs must arrive before the first 300ms fixture response completes');
    assert.equal(directPilot.clientDistinctSocketCount, 3, 'direct pilot must use three distinct client sockets');
    assert.equal(dataOpenAfter - dataOpenBefore, 0, 'direct requests must not open Relay data channels');
    const result = {
      scope: 'direct-only fixture concurrency pilot for the matched local Relay timing baseline',
      boundary: 'plain loopback HTTP/WS without TLS; fixture Gateway and direct fixture URL; no Browser, Expo, public network, phone RTT, or Provider call',
      httpClient: { keepAlive: false, maxSocketsPerOrigin: 3, maxTotalSockets: 6 },
      connectionSetup,
      holdMs: 300,
      directPilot,
      dataOpenBefore,
      dataOpenAfter,
      dataOpenDelta: dataOpenBefore === null || dataOpenAfter === null ? null : dataOpenAfter - dataOpenBefore,
      diagnosticsDropped,
      diagnosticsComplete: diagnosticsDropped === 0,
      providerCalls: 0,
    };
    await context.writeArtifactJson('mobile-relay-get-concurrency.json', result);
    return result;
  }

  const gateGrant = await createGrant({ context, fixture, mounted, agent, activeRequests });
  const gatePilot = await runGatePilot({ fixture, mounted, localRelay, agent, activeRequests, gateGrant, runStartedAt });
  await revokeGrant({ mounted, agent, activeRequests, accessToken: gateGrant.accessToken });

  if (GATE_PILOT_ONLY) {
    const diagnosticsDropped = localRelay.droppedDiagnosticCount();
    const diagnosticsComplete = diagnosticsDropped === 0;
    if (!diagnosticsComplete) blankGateDataOpenCounts(gatePilot);
    const result = {
      scope: 'short gate pilot for actual local Relay session registration and authenticated GET pool admission',
      boundary: 'plain loopback HTTP/WS without TLS; fixture Gateway rather than Studio Gateway; no Browser, Expo, public network, phone RTT, or Provider call',
      httpClient: { keepAlive: false, maxSocketsPerOrigin: 3, maxTotalSockets: 6 },
      connectionSetup,
      gatePilot,
      diagnosticsDropped,
      diagnosticsComplete,
      providerCalls: 0,
    };
    await context.writeArtifactJson('mobile-relay-get-concurrency.json', result);
    return result;
  }

  const samples = [];
  let pairOrdinal = 0;
  for (const holdMs of HOLD_DELAYS_MS) {
    for (let sample = 0; sample < SAMPLES_PER_DELAY; sample += 1) {
      const grant = await createGrant({ context, fixture, mounted, agent, activeRequests });
      const order = pairOrdinal % 2 === 0 ? ['direct', 'relay'] : ['relay', 'direct'];
      const phases = [];
      for (const route of order) {
        const dataOpenBefore = completeDataOpenCount(localRelay);
        const phase = await runAutomaticPhase({
          fixture,
          mounted,
          agent,
          activeRequests,
          accessToken: grant.accessToken,
          route,
          holdMs,
          runStartedAt,
          label: `d${holdMs}-s${sample + 1}-${route}`,
        });
        const dataOpenAfter = completeDataOpenCount(localRelay);
        const dataOpenDelta = dataOpenBefore === null || dataOpenAfter === null ? null : dataOpenAfter - dataOpenBefore;
        if (dataOpenDelta !== null) {
          assert.equal(dataOpenDelta, route === 'relay' ? 2 : 0,
            `${route} phase must have the expected number of Relay data channel opens`);
        }
        if (holdMs >= 300 && route === 'direct') {
          assert.equal(phase.fixtureMaxConcurrentRequests, 3, 'direct fixture must hold all three GETs concurrently');
          assert.equal(phase.endpointThirdReceivedBeforeFirstCompletion, true,
            'all direct GETs must arrive before the first held fixture response completes');
        } else if (holdMs >= 300) {
          assert.equal(phase.fixtureMaxConcurrentRequests <= 2, true, 'Relay GET pool must limit fixture concurrency to two');
          assert.equal(phase.endpointThirdReceivedAfterFirstCompletion, true,
            'third Relay GET must reach the fixture after a held response completes');
        }
        phases.push({
          ...phase,
          dataOpenBefore,
          dataOpenAfter,
          dataOpenDelta,
        });
      }
      await revokeGrant({ mounted, agent, activeRequests, accessToken: grant.accessToken });
      samples.push({ holdMs, sample: sample + 1, order, phases });
      pairOrdinal += 1;
    }
  }

  const diagnosticsDropped = localRelay.droppedDiagnosticCount();
  const diagnosticsComplete = diagnosticsDropped === 0;
  if (!diagnosticsComplete) {
    blankGateDataOpenCounts(gatePilot);
    for (const sample of samples) for (const phase of sample.phases) {
      phase.dataOpenBefore = null;
      phase.dataOpenAfter = null;
      phase.dataOpenDelta = null;
    }
  }
  const result = {
    scope: 'actual local Relay session registration and same-grant authenticated bodyless API GET admission against one deterministic loopback HTTP fixture',
    boundary: 'plain loopback HTTP/WS without TLS; fixture Gateway rather than Studio Gateway; no Browser, Expo, public network, phone RTT, or Provider call',
    poolSource: {
      serverPassesMaxSockets: 'Math.min(2, gateway.maxConnections)',
      localRelayGatewayDefaultMaxConnections: 128,
      effectiveSlotsPerGrant: 2,
      queueTimeoutMs: 5_000,
      basis: 'server.mjs getGrantPool/startMultiRelay plus local-relay.mjs default connectTimeoutMs',
    },
    grantFlow: 'fixture accepts pairing POST and returns a fresh accessToken/rpcToken/expiresAt; Relay itself registers the resulting access grant; each direct/Relay pair reuses the same access token',
    responseContract: { cacheControl: 'no-store', identicalFixtureBody: true, getRequestBodyBytes: 0 },
    httpClient: { keepAlive: false, maxSocketsPerOrigin: 3, maxTotalSockets: 6 },
    connectionSetup,
    gatePilot,
    samplesPerDelay: SAMPLES_PER_DELAY,
    samples,
    lastCompletionStats: summarizeLastCompletions(samples),
    diagnosticsDropped,
    diagnosticsComplete,
    dataOpenCountsComplete: diagnosticsComplete,
    providerCalls: 0,
  };
  await context.writeArtifactJson('mobile-relay-get-concurrency.json', result);
  return result;
});

async function startFixture(context) {
  const pairingToken = randomBytes(32).toString('base64url');
  context.registerSecret(pairingToken);
  const accessTokens = new Set();
  const phases = new Set();
  const server = createServer((request, response) => {
    void handleFixtureRequest({ context, request, response, pairingToken, accessTokens, phases }).catch(() => {
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(500, { 'cache-control': 'no-store', 'content-length': '0' });
        response.end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, resolve);
  });
  const port = server.address().port;
  context.registerPort('mobile-get-concurrency-fixture', port);
  context.addCleanup('close mobile GET concurrency fixture', async () => {
    for (const phase of phases) for (const record of phase.records) record.release?.();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    origin: `http://${LOOPBACK}:${port}`,
    gateway: { baseUrl: `http://${LOOPBACK}:${port}`, port, authToken: pairingToken },
    pairingToken,
    accessTokens,
    phases,
    body: RESPONSE_BODY,
    releasePendingResponses() {
      for (const phase of phases) for (const record of phase.records) record.release?.();
    },
    beginPhase({ label, mode, holdMs = 0, accessToken }) {
      const phase = {
        label,
        mode,
        holdMs,
        accessToken,
        records: [],
        active: 0,
        maxActive: 0,
      };
      phases.add(phase);
      return phase;
    },
  };
}

async function handleFixtureRequest({ context, request, response, pairingToken, accessTokens, phases }) {
  const path = new URL(request.url, 'http://fixture.invalid').pathname;
  if (request.method === 'POST' && path === '/api/mobile/session') {
    const body = await readBody(request, 8 * 1024);
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); } catch { sendEmpty(response, 400); return; }
    if (!payload || payload.token !== pairingToken) { sendEmpty(response, 401); return; }
    const accessToken = randomBytes(32).toString('base64url');
    const rpcToken = randomBytes(32).toString('base64url');
    context.registerSecret(accessToken);
    context.registerSecret(rpcToken);
    accessTokens.add(accessToken);
    sendJson(response, 200, { accessToken, rpcToken, expiresAt: Date.now() + 30 * 60_000 });
    return;
  }
  if (request.method === 'DELETE' && path === '/api/mobile/session') {
    const accessToken = bearer(request);
    if (!accessToken || !accessTokens.has(accessToken)) { sendEmpty(response, 401); return; }
    response.writeHead(204, { 'cache-control': 'no-store', 'content-length': '0' });
    response.end(() => accessTokens.delete(accessToken));
    return;
  }
  if (request.method !== 'GET' || path !== '/api/servers') { sendEmpty(response, 404); return; }

  const phase = [...phases].find(candidate => candidate.label === request.headers['x-p2-phase']);
  const accessToken = bearer(request);
  if (!phase || !accessToken || accessToken !== phase.accessToken || !accessTokens.has(accessToken)) {
    sendEmpty(response, 401);
    return;
  }
  const requestBody = await readBody(request, 16 * 1024);
  if (requestBody.length > 0) { sendEmpty(response, 400); return; }
  const record = {
    receivedAt: performance.now(),
    requestBodyBytes: requestBody.length,
    requestHeaderBytes: incomingHeaderBytes(request),
    responseBodyBytes: RESPONSE_BODY.length,
    completedAt: null,
    release: null,
    timer: null,
  };
  phase.records.push(record);
  phase.active += 1;
  phase.maxActive = Math.max(phase.maxActive, phase.active);
  let finishStarted = false;
  const finish = () => {
    if (finishStarted || response.destroyed || response.writableEnded) return;
    finishStarted = true;
    if (record.timer !== null) clearTimeout(record.timer);
    record.release = null;
    response.once('finish', () => {
      record.completedAt = performance.now();
      phase.active = Math.max(0, phase.active - 1);
    });
    response.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-length': String(RESPONSE_BODY.length),
    });
    response.end(RESPONSE_BODY);
  };
  record.release = finish;
  if (phase.mode !== 'gate') record.timer = setTimeout(finish, phase.holdMs);
}

async function runGatePilot({ fixture, mounted, localRelay, agent, activeRequests, gateGrant, runStartedAt }) {
  const phase = fixture.beginPhase({ label: 'gate-pilot', mode: 'gate', accessToken: gateGrant.accessToken });
  const path = `${mounted.gatewayBaseUrl}/api/servers`;
  const dataOpenBefore = completeDataOpenCount(localRelay);
  const first = beginGet({ agent, activeRequests, url: path, accessToken: gateGrant.accessToken, phaseLabel: phase.label, ordinal: 1 });
  await Promise.all([first.submitted, waitForRecordCount(phase, 1)]);
  const second = beginGet({ agent, activeRequests, url: path, accessToken: gateGrant.accessToken, phaseLabel: phase.label, ordinal: 2 });
  await Promise.all([second.submitted, waitForRecordCount(phase, 2)]);

  const third = beginGet({ agent, activeRequests, url: path, accessToken: gateGrant.accessToken, phaseLabel: phase.label, ordinal: 3 });
  await third.submitted;
  const clientSocketSet = new Set([first.socket, second.socket, third.socket]);
  const allClientSocketsDistinct = first.socket !== null && second.socket !== null && third.socket !== null && clientSocketSet.size === 3;
  assert.equal(allClientSocketsDistinct, true, 'the three independent probe requests must reach Relay on distinct client sockets');
  await delay(GATE_OBSERVATION_MS);
  assert.equal(phase.records.length, 2, 'the third request must not reach the fixture while both grant slots are held');
  const dataOpenWithTwoHeld = completeDataOpenCount(localRelay);
  assert.equal(dataOpenBefore !== null && dataOpenWithTwoHeld !== null, true, 'diagnostic event trace must be complete during the gate pilot');
  assert.equal(dataOpenWithTwoHeld - dataOpenBefore, 2, 'the two held GETs must open two Relay data channels');

  const firstRecord = phase.records[0];
  const releasedAt = performance.now();
  firstRecord.release();
  const thirdRecord = await waitForRecordCount(phase, 3);
  const dataOpenWithThirdArrived = completeDataOpenCount(localRelay);
  assert.ok(thirdRecord.receivedAt >= releasedAt, 'the queued request must reach the fixture only after one held response is released');
  assert.equal(dataOpenWithThirdArrived, dataOpenWithTwoHeld, 'the third GET must reuse a released Relay data channel');

  for (const record of phase.records) record.release?.();
  const responses = await Promise.all([first.response, second.response, third.response]);
  for (const result of responses) assertGetResponse(result, fixture.body);
  assert.equal(phase.records.length, 3);
  assert.equal(phase.records.reduce((sum, record) => sum + record.requestBodyBytes, 0), 0);

  return {
    waitingBehaviorObserved: true,
    clientRequestsConnectedAndFlushed: true,
    allClientSocketsDistinct,
    endpointReceivedBeforeRelease: 2,
    endpointThirdReceivedAfterRelease: true,
    dataOpenBefore: dataOpenBefore,
    dataOpenWithTwoHeld,
    dataOpenWithThirdArrived,
    dataOpenUnchangedForThird: true,
    observationWindowMs: GATE_OBSERVATION_MS,
    internalQueueArrivalOrDurationClaimed: false,
    requestCount: 3,
    requestBodyBytes: 0,
    responseBodyBytes: responses.reduce((sum, result) => sum + result.bodyBytes, 0),
    endpointRequestHeaderBytes: phase.records.reduce((sum, record) => sum + record.requestHeaderBytes, 0),
    endpointFirstReceiveMs: relativeMs(Math.min(...phase.records.map(record => record.receivedAt)), runStartedAt),
    endpointLastReceiveMs: relativeMs(Math.max(...phase.records.map(record => record.receivedAt)), runStartedAt),
    endpointFirstCompleteMs: relativeMs(Math.min(...phase.records.map(record => record.completedAt)), runStartedAt),
    endpointLastCompleteMs: relativeMs(Math.max(...phase.records.map(record => record.completedAt)), runStartedAt),
    clientFirstCompleteMs: relativeMs(Math.min(...responses.map(result => result.completedAt)), runStartedAt),
    clientLastCompleteMs: relativeMs(Math.max(...responses.map(result => result.completedAt)), runStartedAt),
  };
}

async function runAutomaticPhase({ fixture, mounted, agent, activeRequests, accessToken, route, holdMs, runStartedAt, label }) {
  const phase = fixture.beginPhase({ label, mode: 'auto', holdMs, accessToken });
  const url = route === 'direct'
    ? `${fixture.origin}/api/servers`
    : `${mounted.gatewayBaseUrl}/api/servers`;
  const phaseStartedAt = performance.now();
  const requests = [1, 2, 3].map(ordinal => beginGet({
    agent, activeRequests, url, accessToken, phaseLabel: label, ordinal,
  }));
  await Promise.all(requests.map(request => request.submitted));
  await waitForRecordCount(phase, 3);
  const responses = await Promise.all(requests.map(request => request.response));
  for (const result of responses) assertGetResponse(result, fixture.body);
  assert.equal(phase.records.length, 3);
  const clientSockets = requests.map(request => request.socket);
  const clientDistinctSocketCount = new Set(clientSockets.filter(Boolean)).size;
  assert.equal(clientSockets.every(Boolean), true, 'each submitted HTTP request must have a connected client socket');
  assert.equal(clientDistinctSocketCount, requests.length, 'each concurrent HTTP request must use its own client socket');
  const ordered = values => [...values].sort((left, right) => left - right);
  const arrivals = ordered(phase.records.map(record => record.receivedAt));
  const endpointCompletions = ordered(phase.records.map(record => record.completedAt));
  const clientCompletions = ordered(responses.map(result => result.completedAt));
  const requestBodyBytes = phase.records.reduce((sum, record) => sum + record.requestBodyBytes, 0);
  const responseBodyBytes = responses.reduce((sum, result) => sum + result.bodyBytes, 0);
  assert.equal(requestBodyBytes, 0, 'protected API GET requests must remain bodyless');
  assert.equal(responseBodyBytes, requests.length * fixture.body.length, 'all fixture response bytes must be counted exactly');
  return {
    route,
    holdMs,
    endpointReceivedCount: phase.records.length,
    clientRequestCount: requests.length,
    requestBodyBytes,
    requestHeaderBytes: phase.records.reduce((sum, record) => sum + record.requestHeaderBytes, 0),
    responseBodyBytes,
    identicalFixtureBody: true,
    cacheControl: 'no-store',
    fixtureMaxConcurrentRequests: phase.maxActive,
    fixtureObservedHoldMs: summarizeNumbers(phase.records.map(record => record.completedAt - record.receivedAt)),
    endpointFirstReceiveOffsetMs: relativeMs(arrivals[0], phaseStartedAt),
    endpointLastReceiveOffsetMs: relativeMs(arrivals.at(-1), phaseStartedAt),
    endpointFirstCompleteOffsetMs: relativeMs(endpointCompletions[0], phaseStartedAt),
    endpointLastCompleteOffsetMs: relativeMs(endpointCompletions.at(-1), phaseStartedAt),
    endpointThirdReceivedBeforeFirstCompletion: arrivals.at(-1) < endpointCompletions[0],
    endpointThirdReceivedAfterFirstCompletion: arrivals.at(-1) >= endpointCompletions[0],
    clientFirstCompleteOffsetMs: relativeMs(clientCompletions[0], phaseStartedAt),
    clientLastCompleteOffsetMs: relativeMs(clientCompletions.at(-1), phaseStartedAt),
    endpointFirstReceiveMs: relativeMs(arrivals[0], runStartedAt),
    endpointLastReceiveMs: relativeMs(arrivals.at(-1), runStartedAt),
    endpointFirstCompleteMs: relativeMs(endpointCompletions[0], runStartedAt),
    endpointLastCompleteMs: relativeMs(endpointCompletions.at(-1), runStartedAt),
    clientFirstCompleteMs: relativeMs(clientCompletions[0], runStartedAt),
    clientLastCompleteMs: relativeMs(clientCompletions.at(-1), runStartedAt),
    clientConnectedSocketCount: clientSockets.length,
    clientDistinctSocketCount,
    clientSocketReuseCount: clientSockets.length - clientDistinctSocketCount,
  };
}

async function createGrant({ context, fixture, mounted, agent, activeRequests }) {
  const body = Buffer.from(JSON.stringify({ token: fixture.pairingToken }));
  const exchange = requestOnce({
    agent,
    activeRequests,
    url: `${mounted.gatewayBaseUrl}/api/mobile/session`,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body,
  });
  const result = await exchange.response;
  assert.equal(result.status, 200, 'Relay fixture pairing exchange must succeed');
  let payload;
  try { payload = JSON.parse(result.body.toString('utf8')); } catch { payload = null; }
  const valid = payload && typeof payload.accessToken === 'string' && typeof payload.rpcToken === 'string' &&
    typeof payload.expiresAt === 'number' && payload.expiresAt > Date.now();
  assert.equal(Boolean(valid), true, 'fixture must return a valid access grant for Relay registration');
  context.registerSecret(payload.accessToken);
  context.registerSecret(payload.rpcToken);
  return { accessToken: payload.accessToken };
}

async function revokeGrant({ mounted, agent, activeRequests, accessToken }) {
  const exchange = requestOnce({
    agent,
    activeRequests,
    url: `${mounted.gatewayBaseUrl}/api/mobile/session`,
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const result = await exchange.response;
  assert.equal(result.status, 204, 'Relay must revoke the fixture grant after its sample');
}

function beginGet({ agent, activeRequests, url, accessToken, phaseLabel, ordinal }) {
  return requestOnce({
    agent,
    activeRequests,
    url,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'cache-control': 'no-store',
      'x-p2-phase': phaseLabel,
      'x-p2-ordinal': String(ordinal),
    },
  });
}

function requestOnce({ agent, activeRequests, url, method = 'GET', headers = {}, body }) {
  const target = new URL(url);
  let socket = null;
  let connectedResolve;
  let connectedReject;
  let finishedResolve;
  let finishedReject;
  const connected = new Promise((resolve, reject) => { connectedResolve = resolve; connectedReject = reject; });
  const finished = new Promise((resolve, reject) => { finishedResolve = resolve; finishedReject = reject; });
  const request = httpRequest(target, { method, headers, agent });
  request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('Owned loopback HTTP request timed out')));
  request.once('error', connectedReject);
  request.once('error', finishedReject);
  request.once('socket', assigned => {
    socket = assigned;
    if (!assigned.connecting) connectedResolve();
    else assigned.once('connect', connectedResolve);
    assigned.once('error', connectedReject);
  });
  request.once('finish', finishedResolve);
  const submitted = Promise.all([connected, finished]).then(() => ({ socket }));
  const response = new Promise((resolve, reject) => {
    request.once('response', incoming => {
      const chunks = [];
      let bodyBytes = 0;
      incoming.on('data', chunk => {
        bodyBytes += chunk.length;
        if (bodyBytes > 16 * 1024) incoming.destroy(new Error('Fixture response exceeded the bound'));
        else chunks.push(chunk);
      });
      incoming.once('aborted', () => reject(new Error('Owned loopback HTTP response was aborted')));
      incoming.once('error', reject);
      incoming.once('end', () => resolve({
        status: incoming.statusCode || 0,
        body: Buffer.concat(chunks, bodyBytes),
        bodyBytes,
        completedAt: performance.now(),
      }));
    });
    request.once('error', reject);
  });
  void submitted.catch(() => {});
  void response.catch(() => {});
  const handle = {
    get socket() { return socket; },
    submitted,
    response,
    abort() { request.destroy(); },
  };
  activeRequests.add(handle);
  void response.finally(() => activeRequests.delete(handle)).catch(() => {});
  if (body === undefined) request.end(); else request.end(body);
  return handle;
}

function assertGetResponse(result, expectedBody) {
  assert.equal(result.status, 200, 'protected fixture GET must succeed');
  assert.equal(result.body.equals(expectedBody), true, 'direct and Relay routes must return the identical fixture body');
}

function waitForRecordCount(phase, count) {
  return waitFor(() => phase.records.length >= count ? phase.records[count - 1] : null,
    5_000, `fixture request ${count} for ${phase.label}`, 5);
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': String(body.length) });
  response.end(body);
}

function sendEmpty(response, status) {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-length': '0' });
  response.end();
}

function bearer(request) {
  const match = /^Bearer (.+)$/.exec(request.headers.authorization || '');
  return match?.[1] || null;
}

function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        request.destroy();
        reject(new Error('Fixture request body exceeded the bound'));
      } else chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks, bytes)));
    request.once('error', reject);
  });
}

function incomingHeaderBytes(request) {
  let bytes = Buffer.byteLength(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`) + 2;
  for (const value of request.rawHeaders) bytes += Buffer.byteLength(value) + 2;
  return bytes;
}

function completeDataOpenCount(localRelay) {
  if (localRelay.droppedDiagnosticCount() > 0) return null;
  return localRelay.diagnostics().filter(record => record.event === 'data_open').length;
}

function blankGateDataOpenCounts(gatePilot) {
  gatePilot.dataOpenBefore = null;
  gatePilot.dataOpenWithTwoHeld = null;
  gatePilot.dataOpenWithThirdArrived = null;
  gatePilot.dataOpenUnchangedForThird = null;
}

function summarizeLastCompletions(samples) {
  return [0, 300, 600, 1_000].flatMap(holdMs => ['direct', 'relay'].map(route => {
    const values = samples.flatMap(sample => sample.holdMs === holdMs
      ? sample.phases.filter(phase => phase.route === route).map(phase => phase.clientLastCompleteOffsetMs)
      : []);
    return { holdMs, route, ...summarizeNumbers(values) };
  }));
}

function summarizeNumbers(values) {
  if (values.length === 0) return { n: 0, median: null, min: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return { n: sorted.length, median: roundMs(median), min: roundMs(sorted[0]), max: roundMs(sorted.at(-1)) };
}

function relativeMs(value, start) { return roundMs(value - start); }
function roundMs(value) { return Number(value.toFixed(3)); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
