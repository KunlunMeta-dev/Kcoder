import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalGatewayConnectionUrl,
  connectionProofMessage,
  isLoopbackGatewayConnectionUrl,
  parseGatewayConnectionRoutes,
} from '../shared/gatewayConnectionRoutes.js';

const gatewayId = 'a'.repeat(64);
const publicKey = 'b'.repeat(64);
const descriptor = {
  version: 1,
  gatewayId,
  publicKey,
  endpoints: [
    { kind: 'public', url: 'https://relay.example.test/g/abc_123' },
  ],
};

test('Gateway connection descriptor validates canonical roots and Relay mounts without Node crypto', () => {
  assert.deepEqual(parseGatewayConnectionRoutes(descriptor), descriptor);
  assert.equal(canonicalGatewayConnectionUrl('https://studio.example.test/'), 'https://studio.example.test');
  assert.equal(canonicalGatewayConnectionUrl('https://relay.example.test/g/abc_123'), 'https://relay.example.test/g/abc_123');
  assert.equal(canonicalGatewayConnectionUrl('https://relay.example.test/g/abc_123/'), undefined);
  assert.equal(isLoopbackGatewayConnectionUrl('http://127.0.0.1:4173'), true);
  assert.equal(isLoopbackGatewayConnectionUrl('http://[::ffff:7f00:1]:4173'), true);
});

test('descriptor rejects malformed identity fields, unsafe URLs, duplicates, and oversized endpoint lists', () => {
  for (const invalid of [
    { ...descriptor, version: 2 },
    { ...descriptor, gatewayId: 'not-a-hash' },
    { ...descriptor, publicKey: 'c'.repeat(62) },
    { ...descriptor, extra: true },
    { ...descriptor, endpoints: [] },
    { ...descriptor, endpoints: [{ kind: 'lan', url: 'https://user:pass@example.test' }] },
    { ...descriptor, endpoints: [{ kind: 'lan', url: 'https://example.test/path' }] },
    { ...descriptor, endpoints: [{ kind: 'lan', url: 'http://localhost:4173' }] },
    { ...descriptor, endpoints: [{ kind: 'lan', url: 'https://example.test/?token=secret' }] },
    { ...descriptor, endpoints: [descriptor.endpoints[0], descriptor.endpoints[0]] },
    { ...descriptor, endpoints: Array.from({ length: 9 }, (_, index) => ({ kind: 'lan', url: `https://lan-${index}.example.test` })) },
  ]) assert.equal(parseGatewayConnectionRoutes(invalid), undefined);
});

test('connection proof message has a stable, endpoint-bound JSON encoding', () => {
  assert.equal(connectionProofMessage(gatewayId, 'c'.repeat(48), descriptor.endpoints[0].url),
    JSON.stringify(['kcoder.gateway.connection-proof.v1', gatewayId, 'c'.repeat(48), descriptor.endpoints[0].url]));
  assert.throws(() => connectionProofMessage(gatewayId, 'c'.repeat(47), descriptor.endpoints[0].url), TypeError);
  assert.throws(() => connectionProofMessage(gatewayId, 'c'.repeat(48), 'https://studio.example.test/?x=1'), TypeError);
});

test('retired LAN candidates are discarded without changing saved public Gateway identity', () => {
  const retired = { ...descriptor, endpoints: [{ kind: 'lan', url: 'https://192.168.1.20' }, ...descriptor.endpoints] };
  assert.deepEqual(parseGatewayConnectionRoutes(retired), descriptor);
  assert.equal(parseGatewayConnectionRoutes({ ...descriptor, endpoints: retired.endpoints.slice(0, 1) }), undefined);
});
