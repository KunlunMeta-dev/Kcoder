import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { startRelay } from '../src/server.mjs';
import { isolatedGatewayAuthority } from '../src/gateway-origin.mjs';

test('Relay-originated unavailability has its own safe correlation ID and retry hint', async t => {
  const relay = await startRelay({ gateways: [{ id: 'owned', secret: 'a'.repeat(40), gatewaySecret: 'b'.repeat(40) }],
    sharedHosts: ['diagnostic.example'], controlPort: 0, proxyPort: 0 });
  t.after(() => relay.close());
  const result = await new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: relay.proxyPort, path: '/g/owned/api/servers',
      headers: { host: isolatedGatewayAuthority('diagnostic.example', 'owned'), 'x-request-id': 'untrusted-input' } }, response => {
      let body = ''; response.on('data', value => body += value); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    outgoing.once('error', reject); outgoing.end();
  });
  assert.equal(result.status, 503);
  assert.match(result.headers['x-request-id'], /^[a-f0-9-]{36}$/);
  assert.equal(result.headers['x-kcoder-error-layer'], 'relay');
  assert.equal(result.headers['retry-after'], '5');
  assert.doesNotMatch(result.body, /untrusted-input|owned|secret/);
});
