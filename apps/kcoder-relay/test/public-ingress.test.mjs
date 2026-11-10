import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createPublicIngress } from '../src/public-ingress.mjs';
import { isolatedGatewayUrl } from '../src/gateway-origin.mjs';

test('registration starts one TLS handshake per public host and readiness waits for it', async t => {
  const origin = 'https://relay.example.test:8451';
  const host = isolatedGatewayUrl(origin, 'registered-gateway').hostname;
  const handshakes = [];
  const ingress = createPublicIngress(origin, (port, servername, signal) => new Promise((resolve, reject) => {
    handshakes.push({ port, servername, signal, resolve });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  t.after(() => ingress.close());
  ingress.prepare('registered-gateway');
  assert.equal(ingress.status('registered-gateway', origin), 'preparing');
  await setImmediate();
  assert.equal(handshakes.length, 1);
  assert.equal(handshakes[0].port, 8451);
  assert.equal(handshakes[0].servername, host);
  handshakes[0].resolve();
  await setImmediate();
  assert.equal(ingress.status('registered-gateway', origin), 'ready');
  ingress.prepare('another-gateway');
  await setImmediate();
  ingress.remove('another-gateway');
  assert.equal(handshakes[1].signal.aborted, true);
});
