import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayListenHost } from './gateway-connectivity.js';

const publicUrl = 'https://relay.example.test:8451/g/gateway-a';

test('Gateways default to loopback while explicit listener settings remain authoritative', () => {
  assert.equal(gatewayListenHost({ KCODER_STUDIO_PUBLIC_ACCESS_URL: publicUrl }), '127.0.0.1');
  assert.equal(gatewayListenHost({}), '127.0.0.1');
  assert.equal(gatewayListenHost({ KCODER_STUDIO_PUBLIC_ACCESS_URL: publicUrl, KCODER_STUDIO_HOST: '::' }), '::');
  assert.equal(gatewayListenHost({ KCODER_STUDIO_PUBLIC_ACCESS_URL: publicUrl, KCODER_STUDIO_HOST: '127.0.0.1' }), '127.0.0.1');
});
