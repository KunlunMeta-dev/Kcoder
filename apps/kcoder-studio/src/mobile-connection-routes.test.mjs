import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  attachMobileConnectionRoutes,
  createMobileConnectionProofHandler,
  createMobileConnectionRoutes,
  createPublicPairingReadiness,
} from './mobile-connection-routes.js';

const identity = { version: 1, gatewayId: 'a'.repeat(64), publicKey: 'b'.repeat(64) };
const publicUrl = 'https://relay.example.test/g/relay_123';

test('public pairing is published only after a matching signed proof returns', async () => {
  const signConnectionProof = (nonce, endpoint) => ({ version: 1, gatewayId: identity.gatewayId, nonce, endpoint, signature: 'c'.repeat(128) });
  let finish;
  let calls = 0;
  const readiness = createPublicPairingReadiness({ signConnectionProof, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(init.redirect, 'error');
    await new Promise(resolve => { finish = resolve; });
    return Response.json(signConnectionProof(url.searchParams.get('nonce'), url.searchParams.get('endpoint')));
  } });
  assert.equal(readiness(publicUrl), 'preparing');
  assert.equal(readiness(publicUrl), 'preparing');
  assert.equal(calls, 1);
  finish();
  await setImmediate();
  assert.equal(readiness(publicUrl), 'ready');
});

test('advertises only the configured public endpoint regardless of local interfaces or retired LAN options', () => {
  const routes = createMobileConnectionRoutes({
    identity, publicAccessUrl: publicUrl, host: '0.0.0.0', port: 4173,
    lanAccessUrls: ['https://studio.example.test'],
    interfaces: { eth0: [{ address: '192.168.1.10', family: 'IPv4', internal: false }] },
    isAllowedAuthority: () => true,
  });
  assert.deepEqual(routes.endpoints, [{ kind: 'public', url: publicUrl }]);
});

test('does not advertise an endpoint without a public URL or outside Host admission', () => {
  assert.equal(createMobileConnectionRoutes({ identity }), undefined);
  assert.equal(createMobileConnectionRoutes({ identity, publicAccessUrl: publicUrl, isAllowedAuthority: () => false }), undefined);
  assert.equal(createMobileConnectionRoutes({ identity, publicAccessUrl: 'http://127.0.0.1:4173' }), undefined);
});

test('unauthenticated proof handler signs only a strict allowlisted GET and returns the agreed top-level shape', async () => {
  const routes = createMobileConnectionRoutes({ identity, publicAccessUrl: publicUrl });
  const nonce = 'c'.repeat(48);
  const expectedProof = { version: 1, gatewayId: identity.gatewayId, nonce, endpoint: routes.endpoints[0].url, signature: 'd'.repeat(128) };
  const calls = [];
  const handler = createMobileConnectionProofHandler({
    getConnectionRoutes: async () => routes,
    signConnectionProof: async (...args) => { calls.push(args); return expectedProof; },
    jsonResponse: (response, status, payload, headers = {}) => Object.assign(response, { status, payload, headers }),
  });
  const request = { method: 'GET', headers: {} };
  const response = {};
  const url = new URL(`http://studio.example.test/api/mobile/connection-proof?nonce=${nonce}&endpoint=${encodeURIComponent(routes.endpoints[0].url)}`);
  assert.equal(await handler(request, response, url), true);
  assert.equal(response.status, 200);
  assert.deepEqual(response.payload, expectedProof);
  assert.deepEqual(calls, [[nonce, routes.endpoints[0].url]]);
  assert.deepEqual(request.headers, {});

  const cachedProbe = new URL(url);
  cachedProbe.searchParams.set('_', '1793706788427');
  const cachedResponse = {};
  assert.equal(await handler(request, cachedResponse, cachedProbe), true);
  assert.equal(cachedResponse.status, 200);
  assert.deepEqual(calls.at(-1), [nonce, routes.endpoints[0].url], 'the cachebuster is ignored by proof signing');

  const rejected = {};
  const duplicate = new URL(`http://studio.example.test/api/mobile/connection-proof?nonce=${nonce}&nonce=${nonce}&endpoint=${encodeURIComponent(routes.endpoints[0].url)}`);
  assert.equal(await handler(request, rejected, duplicate), true);
  assert.equal(rejected.status, 400);
  assert.equal(calls.length, 2);
});

test('proof query compatibility keeps every other anonymous request boundary strict', async () => {
  const routes = createMobileConnectionRoutes({ identity, publicAccessUrl: publicUrl });
  const nonce = 'c'.repeat(48);
  const calls = [];
  const handler = createMobileConnectionProofHandler({
    getConnectionRoutes: async () => routes,
    signConnectionProof: async (...args) => { calls.push(args); return {
      version: 1, gatewayId: identity.gatewayId, nonce: args[0], endpoint: args[1], signature: 'd'.repeat(128),
    }; },
    jsonResponse: (response, status, payload, headers = {}) => Object.assign(response, { status, payload, headers }),
  });
  const endpoint = encodeURIComponent(routes.endpoints[0].url);
  const base = `http://studio.example.test/api/mobile/connection-proof?nonce=${nonce}&endpoint=${endpoint}`;
  const invalidUrls = [
    `${base}&extra=1`,
    `${base}&endpoint=${endpoint}`,
    `${base}&_=1&_=2`,
    `${base}&_=` ,
    `${base}&_=12345678901234567`,
    `http://studio.example.test/api/mobile/connection-proof?%6Eonce=${nonce}&endpoint=${endpoint}`,
    `http://studio.example.test/api/mobile/connection-proof?nonce=${nonce}&%65ndpoint=${endpoint}`,
    `${base}&padding=${'x'.repeat(4096)}`,
  ];
  for (const value of invalidUrls) {
    const response = {};
    assert.equal(await handler({ method: 'GET', headers: {} }, response, new URL(value)), true);
    assert.equal(response.status, 400, value);
  }

  for (const headers of [
    { 'content-length': '1' },
    { 'transfer-encoding': 'chunked' },
    { expect: '100-continue' },
  ]) {
    const response = {};
    assert.equal(await handler({ method: 'GET', headers }, response, new URL(base)), true);
    assert.equal(response.status, 400);
  }
  assert.deepEqual(calls, [], 'invalid queries and GET bodies do not request a signature');
});

test('Mobile connection route attachment preserves existing session and bootstrap fields', () => {
  const response = { accessToken: 'session', capabilities: { mobileInitialServersV1: true }, servers: [{ id: 'local' }] };
  const routes = { version: 1, gatewayId: identity.gatewayId, publicKey: identity.publicKey, endpoints: [{ kind: 'public', url: publicUrl }] };
  assert.deepEqual(attachMobileConnectionRoutes(response, routes), { ...response, connectionRoutes: routes });
  assert.equal(attachMobileConnectionRoutes(response, undefined), response);
  assert.equal(createMobileConnectionRoutes({ identity, host: '127.0.0.1', port: 4173 }), undefined);
});
