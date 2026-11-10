import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startGateway } from '../../harness/gateway.mjs';
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';

const DEVICE_LIMIT = 32;
const SERVER_ID = 'mobile-fifo-fixture';

await runE2E(import.meta.url, {
  testId: 'gateway-mobile-device-fifo-eviction-and-session-cleanup',
  tier: 'pr-smoke',
  modelPolicy: 'model-independent owned Gateway HTTP pairing/refresh and mock JSON-RPC WebSocket lifecycle; no Provider or model request',
}, async context => {
  const workspace = context.pathInState('workspace');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const serversFile = await context.writeStateJson('servers.json', [{
    id: SERVER_ID,
    label: 'Owned Mobile FIFO fixture',
    transport: 'local',
    command: process.execPath,
    workspace,
  }]);
  const serversStore = context.pathInState('gateway-store/servers.json');
  const gateway = await startGateway(context, {
    auth: true,
    label: 'mobile-fifo-gateway',
    workspace,
    serversFile,
    serversStore,
    env: {
      KCODER_STUDIO_MOCK: '1',
      KCODER_STUDIO_MOBILE_ACCESS_TTL_MS: '3600000',
      KCODER_STUDIO_AUTH_SESSION_TTL_MS: '3600000',
    },
  });

  const pair = async index => {
    const response = await fetch(`${gateway.baseUrl}/api/mobile/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        token: gateway.authToken,
        durableDeviceAuthorization: true,
        deviceLabel: `owned-fifo-${String(index).padStart(2, '0')}`,
        requestInitialServers: false,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return { response, grant: response.status === 200 ? await response.json() : null };
  };
  const rememberSecrets = grant => {
    for (const name of ['accessToken', 'refreshToken', 'rpcToken']) {
      if (typeof grant?.[name] === 'string' && grant[name].length >= 8) context.registerSecret(grant[name]);
    }
  };

  const grants = [];
  for (let index = 1; index <= DEVICE_LIMIT; index += 1) {
    const { response, grant } = await pair(index);
    assert.equal(response.status, 200, `durable device ${index} of ${DEVICE_LIMIT} must pair`);
    assert.ok(grant && typeof grant.deviceId === 'string', `durable device ${index} must return its device grant`);
    assert.equal(grant.capabilities?.mobileRefreshV1, true);
    assert.equal(Object.hasOwn(grant, 'evictedDeviceIds'), false, 'the public grant must not disclose eviction internals');
    rememberSecrets(grant);
    grants.push(grant);
  }

  const firstRpc = await openRpc(gatewayRpcUrl(gateway, SERVER_ID, grants[0].rpcToken), {
    headers: { authorization: `Bearer ${grants[0].accessToken}` },
  });
  context.addCleanup('close oldest Mobile device RPC', () => closeRpcAndWait(firstRpc, 'oldest Mobile device RPC'));
  await initializeRpc(firstRpc, 'mobile-fifo-oldest-device');

  const secondRpc = await openRpc(gatewayRpcUrl(gateway, SERVER_ID, grants[1].rpcToken), {
    headers: { authorization: `Bearer ${grants[1].accessToken}` },
  });
  context.addCleanup('close surviving Mobile device RPC', () => closeRpcAndWait(secondRpc, 'surviving Mobile device RPC'));
  await initializeRpc(secondRpc, 'mobile-fifo-second-device');

  await context.writeArtifactJson('capacity-before-overflow.json', {
    pairedDevices: grants.length,
    oldestSocketInitialized: firstRpc.socket.readyState === 1,
    secondSocketInitialized: secondRpc.socket.readyState === 1,
    gatewayMode: 'KCODER_STUDIO_MOCK',
  });

  const overflow = await pair(DEVICE_LIMIT + 1);
  await context.writeArtifactJson('overflow-pair-status.json', { status: overflow.response.status });
  assert.equal(overflow.response.status, 200, 'the 33rd durable pairing must evict the FIFO device and succeed');
  assert.ok(overflow.grant && typeof overflow.grant.deviceId === 'string', 'the 33rd pairing must return a device grant');
  assert.equal(overflow.grant.capabilities?.mobileRefreshV1, true);
  assert.equal(Object.hasOwn(overflow.grant, 'evictedDeviceIds'), false, 'eviction details must stay private to Gateway');
  rememberSecrets(overflow.grant);

  await waitFor(() => firstRpc.socket.readyState === 3, 10_000, 'evicted oldest Mobile device socket to close', 25, context.abortSignal);
  assert.equal(secondRpc.socket.readyState, 1, 'the second device socket must remain connected');
  const secondSocketProbe = await secondRpc.request('thread/list', { archived: false });
  assert.ok(Array.isArray(secondSocketProbe.threads), 'the surviving socket must still answer mock RPC');

  const deviceResponse = await fetch(`${gateway.baseUrl}/api/mobile/devices`, {
    headers: { authorization: `Bearer ${grants[1].accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(deviceResponse.status, 200, 'a surviving device can read the active device list');
  const devices = (await deviceResponse.json()).devices;
  assert.equal(devices.length, DEVICE_LIMIT, 'the Gateway must retain exactly 32 durable devices');
  const activeIds = new Set(devices.map(device => device.id));
  assert.equal(activeIds.size, DEVICE_LIMIT, 'active device IDs must be unique');
  assert.equal(activeIds.has(grants[0].deviceId), false, 'the oldest registered device must be evicted');
  assert.equal(activeIds.has(overflow.grant.deviceId), true, 'the new device must occupy the released slot');
  for (const grant of grants.slice(1)) assert.equal(activeIds.has(grant.deviceId), true, 'newer registrations must remain active');

  const rejectedOldestRefresh = await fetch(`${gateway.baseUrl}/api/mobile/session/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ refreshToken: grants[0].refreshToken, rotationId: randomUUID(), deviceId: grants[0].deviceId }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(rejectedOldestRefresh.status, 401, 'the evicted device refresh token must no longer authorize');

  const survivingRefresh = await fetch(`${gateway.baseUrl}/api/mobile/session/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ refreshToken: grants[1].refreshToken, rotationId: randomUUID(), deviceId: grants[1].deviceId }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(survivingRefresh.status, 200, 'a newer device refresh token must remain valid');
  const refreshedSecond = await survivingRefresh.json();
  assert.equal(refreshedSecond.deviceId, grants[1].deviceId);
  assert.equal(refreshedSecond.capabilities?.mobileRefreshV1, true);
  assert.equal(Object.hasOwn(refreshedSecond, 'evictedDeviceIds'), false);
  rememberSecrets(refreshedSecond);

  await context.writeArtifactJson('fifo-eviction-observed.json', {
    pairedDevicesBeforeOverflow: grants.length,
    overflowStatus: overflow.response.status,
    activeDeviceCount: devices.length,
    oldestDeviceAbsent: !activeIds.has(grants[0].deviceId),
    newestDevicePresent: activeIds.has(overflow.grant.deviceId),
    oldestRefreshStatus: rejectedOldestRefresh.status,
    survivingRefreshStatus: survivingRefresh.status,
    oldestSocketClosed: firstRpc.socket.readyState === 3,
    secondSocketStillResponsive: secondRpc.socket.readyState === 1 && Array.isArray(secondSocketProbe.threads),
    evictionInternalsInWire: false,
    modelRequests: 0,
  });

  return {
    pairedBeforeOverflow: grants.length,
    activeDevicesAfterOverflow: devices.length,
    oldestRefreshStatus: rejectedOldestRefresh.status,
    survivingRefreshStatus: survivingRefresh.status,
    oldestSocketClosed: true,
    secondSocketStillResponsive: true,
  };
});
