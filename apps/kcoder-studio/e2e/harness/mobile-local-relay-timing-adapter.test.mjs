import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { connect as connectTcp } from 'node:net';
import test from 'node:test';
import { RunContext } from './run-context.mjs';
import {
  MOBILE_LOCAL_RELAY_TIMING_ADAPTER_VERSION,
  assertMobileLocalRelayTimingRoute,
  createMobileLocalRelayTimingLaneDescriptor,
  fetchAndValidateMobileLocalRelayEntry,
  redactedMobileLocalRelayTimingSummary,
  startMobileLocalRelayTimingAdapter,
  validateMobileLocalRelayEntry,
} from './mobile-local-relay-timing-adapter.mjs';

const relayOrigin = 'http://127.0.0.1:41237';
const gatewayId = 'privateGateway_7';
const gatewayPrefix = `/g/${gatewayId}`;
const gatewayUrl = `${relayOrigin}${gatewayPrefix}`;
const mobileUrl = `${gatewayUrl}/mobile/`;
const workerUrl = `${mobileUrl}__kcoder_offline_sw.js`;

test('versioned lane descriptor and entry keep the full Gateway mount across Mobile, API, RPC, and worker routes', async () => {
  const lane = createMobileLocalRelayTimingLaneDescriptor({
    origin: relayOrigin,
    gatewayBaseUrl: gatewayUrl,
    mobileEntryUrl: `${gatewayUrl}/mobile-entry`,
    mobileUrl,
  });

  assert.equal(MOBILE_LOCAL_RELAY_TIMING_ADAPTER_VERSION, 1);
  assert.equal(lane.version, 1);
  assert.equal(lane.gatewayPrefix, gatewayPrefix);
  assert.equal(lane.gatewayUrl, gatewayUrl);
  assert.equal(lane.mobileEntryUrl, `${gatewayUrl}/mobile-entry`);
  assert.equal(lane.mobileUrl, mobileUrl);
  assert.equal(lane.rpcUrl, `ws://127.0.0.1:41237${gatewayPrefix}/rpc`);
  assert.equal(lane.workerUrl, workerUrl);
  assert.equal(lane.workerScope, mobileUrl);
  assert.equal(lane.workerScopePath, `${gatewayPrefix}/mobile/`);

  assert.equal(validateMobileLocalRelayEntry(lane, {
    version: 1,
    available: true,
    mobileUrl,
    gatewayUrl,
  }), true);
  const entryRequests = [];
  await fetchAndValidateMobileLocalRelayEntry(lane, async (url, options) => {
    entryRequests.push({ url, options });
    return {
      status: 200,
      url: lane.mobileEntryUrl,
      redirected: false,
      headers: { get: name => name === 'content-type' ? 'application/json; charset=utf-8' : null },
      json: async () => ({ version: 1, available: true, mobileUrl, gatewayUrl }),
    };
  });
  assert.equal(entryRequests.length, 1);
  assert.equal(entryRequests[0].url, lane.mobileEntryUrl);
  assert.deepEqual(entryRequests[0].options, {
    method: 'GET',
    redirect: 'manual',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  await assert.rejects(fetchAndValidateMobileLocalRelayEntry(lane, async () => ({
    status: 200,
    url: `${relayOrigin}/g/other/mobile-entry`,
    json: async () => ({ version: 1, available: true, mobileUrl, gatewayUrl }),
  })), /does not match its owned mount/);
  assert.equal(assertMobileLocalRelayTimingRoute(lane, lane.mobileEntryUrl, 'entry'), true);
  assert.equal(assertMobileLocalRelayTimingRoute(lane, lane.gatewayUrl, 'gateway'), true);
  assert.equal(assertMobileLocalRelayTimingRoute(lane, lane.mobileUrl, 'mobile'), true);
  assert.equal(assertMobileLocalRelayTimingRoute(lane, `${mobileUrl}_expo/static/js/web/entry.js`, 'asset'), true);
  assert.equal(assertMobileLocalRelayTimingRoute(lane, `${gatewayUrl}/api/mobile/session`, 'api'), true);
  assert.equal(assertMobileLocalRelayTimingRoute(lane, lane.rpcUrl, 'rpc'), true);
  assert.equal(assertMobileLocalRelayTimingRoute(lane, lane.workerUrl, 'worker'), true);
  assert.equal(assertMobileLocalRelayTimingRoute(lane, lane.workerScope, 'worker-scope'), true);

  const summary = redactedMobileLocalRelayTimingSummary(lane);
  assert.equal(summary.gatewayPath, '/g/<gateway>');
  assert.equal(summary.mobilePath, '/g/<gateway>/mobile/');
  assert.equal(summary.rpcPath, '/g/<gateway>/rpc');
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(gatewayId));
  assert.doesNotMatch(JSON.stringify(summary), /pairing|token|credential/i);
});

test('lane descriptor rejects inconsistent Relay routes and entry payloads', () => {
  assert.throws(() => createMobileLocalRelayTimingLaneDescriptor({
    origin: relayOrigin,
    gatewayBaseUrl: gatewayUrl,
    mobileEntryUrl: `${gatewayUrl}/mobile-entry`,
    mobileUrl: `http://127.0.0.1:41238${gatewayPrefix}/mobile/`,
  }), /exact mount prefix/);

  const lane = createMobileLocalRelayTimingLaneDescriptor({
    origin: relayOrigin,
    gatewayBaseUrl: gatewayUrl,
    mobileEntryUrl: `${gatewayUrl}/mobile-entry`,
    mobileUrl,
  });
  for (const payload of [
    { version: 1, available: false, mobileUrl, gatewayUrl },
    { version: 1, available: true, mobileUrl: `${relayOrigin}/g/other/mobile/`, gatewayUrl },
    { version: 1, available: true, mobileUrl, gatewayUrl: `${relayOrigin}/g/other` },
    { version: 1, available: true, mobileUrl, gatewayUrl, accessToken: 'must-not-be-accepted' },
  ]) {
    assert.throws(() => validateMobileLocalRelayEntry(lane, payload), /does not match its owned mount/);
  }
});

test('route assertions reject missing, different, or encoded Gateway and worker mount prefixes', () => {
  const lane = createMobileLocalRelayTimingLaneDescriptor({
    origin: relayOrigin,
    gatewayBaseUrl: gatewayUrl,
    mobileEntryUrl: `${gatewayUrl}/mobile-entry`,
    mobileUrl,
  });
  const invalid = [
    [`${relayOrigin}/mobile/`, 'mobile'],
    [`${relayOrigin}/g/${gatewayId}-other/mobile/index.html`, 'asset'],
    [`${relayOrigin}/g/other/api/mobile/session`, 'api'],
    [`${relayOrigin}/api/mobile/session`, 'api'],
    [`${relayOrigin}${gatewayPrefix}/mobile-extra/index.html`, 'asset'],
    [`${relayOrigin}${gatewayPrefix}/mobile/%2fapi/mobile/session`, 'asset'],
    [`${relayOrigin}${gatewayPrefix}/mobile/__kcoder_offline_sw.js?cache=1`, 'worker'],
    [`${relayOrigin}${gatewayPrefix}/mobile/`, 'worker'],
    [`http://127.0.0.1:41238${gatewayPrefix}/rpc`, 'rpc'],
    [`ws://127.0.0.1:41237${gatewayPrefix}/rpc/other`, 'rpc'],
    [`ws://user@127.0.0.1:41237${gatewayPrefix}/rpc`, 'rpc'],
  ];
  for (const [url, kind] of invalid) {
    assert.throws(() => assertMobileLocalRelayTimingRoute(lane, url, kind), /violates its owned mount/);
  }
  assert.throws(() => assertMobileLocalRelayTimingRoute(lane, lane.mobileUrl, 'unclassified'), /Unsupported/);
});

test('unowned Gateway rejection closes this adapter owned Relay and RunContext cleanup remains safe', async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: 'mobile-local-relay-timing-adapter-failure-cleanup',
    tier: 'full-integration',
    modelPolicy: 'owned loopback Relay origin injection and unowned Gateway pre-registration rejection cleanup; no Browser or model request',
    cleanupTimeoutMs: 10_000,
  });
  let failure;
  let adapter;
  let result;

  try {
    adapter = await startMobileLocalRelayTimingAdapter(context);
    assert.deepEqual(adapter.gatewayEnvironment, {
      KCODER_STUDIO_PUBLIC_ORIGINS: adapter.origin,
      KCODER_STUDIO_MOBILE_WEB_ORIGINS: adapter.origin,
    });
    const ownedPorts = context.ports.map(row => row.port);
    await assert.rejects(adapter.connectGateway({
      baseUrl: 'http://127.0.0.1:4173',
      port: 4173,
      authToken: 'A'.repeat(43),
    }), /RunContext-owned loopback origin/);
    assert.equal(adapter.isOnline(), false);
    for (const port of ownedPorts) await assertPortClosed(port);
    result = {
      outcome: 'unowned Gateway rejection closed the owned Relay immediately',
      originAllowlistKeys: Object.keys(adapter.gatewayEnvironment).sort(),
      ownedRelayPortsClosed: ownedPorts.length,
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

async function assertPortClosed(port) {
  await new Promise((resolve, reject) => {
    const socket = connectTcp({ host: '127.0.0.1', port });
    socket.setTimeout(1_000);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('Adapter-owned Relay listener remained open after unowned Gateway rejection'));
    });
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(new Error('Could not verify an adapter-owned Relay listener was closed'));
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Timed out verifying an adapter-owned Relay listener was closed'));
    });
  });
}
