// This checks an already-running public relay; it never deploys services or requests a model turn.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { loadEnv, relayServerConfig } from './config.mjs';
import { readRegisteredClientId, resolveIdentityFile } from './client-identity.mjs';
import { createRelayUrls, resolveRelayRouteMode } from '../deploy/config.mjs';

loadEnv();
const configuredId = process.env.KCODER_RELAY_GATEWAY_ID || process.env.KCODER_RELAY_DEVICE_ID;
const registrationKey = process.env.KCODER_RELAY_REGISTRATION_KEY || '';
if (registrationKey && !/^[A-Za-z0-9._~-]{32,512}$/.test(registrationKey)) {
  throw new Error('Invalid relay registration key');
}
let selectedGateway;
const identityFile = resolveIdentityFile();
const identityMode = Boolean(
  registrationKey || process.env.KCODER_RELAY_IDENTITY_FILE
  || existsSync(identityFile)
);
let relayConfig;
if (identityMode) {
  const pairingToken = process.env.KCODER_RELAY_GATEWAY_TOKEN || '';
  if (!pairingToken) throw new Error('Set KCODER_RELAY_GATEWAY_TOKEN for this local Gateway before verification');
  const id = await readRegisteredClientId({
    identityFile,
    relayUrl: process.env.KCODER_RELAY_PUBLIC_URL,
    pairingToken,
  });
  selectedGateway = { id, pairingToken };
} else {
  relayConfig = relayServerConfig();
  if (configuredId) selectedGateway = relayConfig.gateways.find(gateway => gateway.id === configuredId);
  else if (relayConfig.gateways.length === 1) [selectedGateway] = relayConfig.gateways;
  else throw new Error('Configure KCODER_RELAY_GATEWAY_ID to select a Gateway for verification');
  if (!selectedGateway) throw new Error('Configured Gateway ID is not present in the relay registry');
}

const isRegistryMode = identityMode || Boolean(process.env.KCODER_RELAY_REGISTRY_FILE);
const routeMode = resolveRelayRouteMode({
  registryMode: isRegistryMode,
  routeMode: process.env.KCODER_RELAY_ROUTE_MODE,
});
const urls = createRelayUrls({
  publicUrl: process.env.KCODER_RELAY_PUBLIC_URL,
  gatewayId: selectedGateway.id,
  routeMode,
  registryMode: isRegistryMode,
});
const gatewayUrl = urls.gatewayBase.toString().replace(/\/$/, '');
const gatewayEndpoint = path => urls.gatewayEndpoint(path);
const evidenceDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../target/kcoder-relay');
const healthUrl = new URL('/_relay/health', urls.publicRoot);
const health = await fetch(healthUrl).then(r => r.json());
assert.equal(health.online, true);

const sessionUrl = gatewayEndpoint('/api/mobile/session');
const denied = await fetch(sessionUrl, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"token":"invalid"}',
});
assert.equal(denied.status, 401);
const response = await fetch(sessionUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: selectedGateway.pairingToken }),
});
assert.equal(response.status, 200);
const session = await response.json();
const headers = { authorization: `Bearer ${session.accessToken}` };
try {
  const serversResponse = await fetch(gatewayEndpoint('/api/servers'), { headers });
  assert.equal(serversResponse.status, 200);
  const { servers } = await serversResponse.json();
  assert.equal(servers[0].id, 'local');
  const endpoint = gatewayEndpoint('/rpc');
  endpoint.protocol = 'wss:';
  endpoint.searchParams.set('token', session.rpcToken);
  endpoint.searchParams.set('server', 'local');
  const ws = new WebSocket(endpoint, { headers, handshakeTimeout: 10000 });
  ws.on('error', () => {});
  const pending = new Map();
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    const callback = pending.get(msg.id);
    if (callback) { pending.delete(msg.id); callback(msg); }
  });
  let nextId = 0;
  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
      pending.set(id, msg => { clearTimeout(timer); if (msg.error) reject(new Error(`${method}: ${msg.error.message}`)); else resolve(msg.result); });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
  try {
    await once(ws, 'open');
    const init = await rpc('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'kcoder-relay-verifier', version: '0.1.0' }, capabilities: { experimental: { threadRunSummaryV1: true } } });
    assert.equal(init.protocolVersion, '2026-07-27');
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }));
    const threads = await rpc('thread/list', { limit: 1 });
    const evidence = {
      timestamp: new Date().toISOString(),
      publicUrl: gatewayUrl,
      healthUrl: healthUrl.toString(),
      gatewayId: selectedGateway.id,
      scope: 'HTTPS/WSS, pairing rejection, mobile session, server list, app-server initialize, thread/list',
      https: 'PASS', invalidPairingToken: 'PASS', mobileSession: 'PASS', serverList: 'PASS',
      wss: 'PASS', appServerInitialize: 'PASS', threadList: 'PASS',
      protocolVersion: init.protocolVersion,
      threadResultKeys: Object.keys(threads || {}),
      realPhone: 'UNVERIFIED', modelTurn: 'NOT_RUN', deploymentPerformedByVerifier: false,
    };
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(resolve(evidenceDir, 'verification.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
  } finally { ws.terminate(); }
} finally {
  await fetch(sessionUrl, { method: 'DELETE', headers });
}
