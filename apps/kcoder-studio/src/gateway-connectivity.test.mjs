import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayListenHost, gatewayPeerOptions, gatewayStunUrl } from './gateway-connectivity.js';

const publicUrl = 'https://relay.example.test:8451/g/gateway-a';

test('Gateways default to loopback while explicit listener settings remain authoritative', () => {
  assert.equal(gatewayListenHost({ KCODER_STUDIO_PUBLIC_ACCESS_URL: publicUrl }), '127.0.0.1');
  assert.equal(gatewayListenHost({}), '127.0.0.1');
  assert.equal(gatewayListenHost({ KCODER_STUDIO_PUBLIC_ACCESS_URL: publicUrl, KCODER_STUDIO_HOST: '::' }), '::');
  assert.equal(gatewayListenHost({ KCODER_STUDIO_PUBLIC_ACCESS_URL: publicUrl, KCODER_STUDIO_HOST: '127.0.0.1' }), '127.0.0.1');
});

test('P2P defaults on and derives STUN from the configured Relay hostname', () => {
  assert.deepEqual(gatewayPeerOptions({}, publicUrl), { enabled: true, stunUrls: 'stun:relay.example.test:8452' });
  assert.deepEqual(gatewayPeerOptions({}, new URL(publicUrl)), { enabled: true, stunUrls: 'stun:relay.example.test:8452' });
  assert.equal(gatewayStunUrl(publicUrl, '9999'), 'stun:relay.example.test:9999');
  assert.equal(gatewayStunUrl('https://[2001:db8::1]/g/a'), 'stun:[2001:db8::1]:8452');
  assert.deepEqual(gatewayPeerOptions({}, null), { enabled: true, stunUrls: '' });
});

test('explicit operator settings win and malformed flags or STUN derivation fail closed', () => {
  assert.deepEqual(gatewayPeerOptions({ KCODER_STUDIO_P2P: '0', KCODER_STUDIO_P2P_STUN_URLS: 'stun:own.example:3478' }, publicUrl),
    { enabled: false, stunUrls: 'stun:own.example:3478' });
  assert.equal(gatewayPeerOptions({ KCODER_STUDIO_P2P_STUN_URLS: '' }, publicUrl).stunUrls, '');
  assert.throws(() => gatewayPeerOptions({ KCODER_STUDIO_P2P: 'false' }, publicUrl));
  for (const port of [0, 80, 65536, 'bad']) assert.throws(() => gatewayStunUrl(publicUrl, port));
  for (const url of ['file:///tmp/relay', 'https://user:pass@relay.example', publicUrl + '?token=private']) {
    assert.throws(() => gatewayStunUrl(url));
  }
});
