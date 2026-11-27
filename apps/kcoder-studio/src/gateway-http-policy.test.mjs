import assert from 'node:assert/strict';
import test from 'node:test';
import { beginGatewayResponse, gatewayContentSecurityPolicy } from './gateway-http-policy.mjs';

test('request IDs and HTTPS headers use host-owned facts, never forwarded client claims', () => {
  const response = () => ({ headers: {}, setHeader(name, value) { this.headers[name] = value; } });
  const local = response();
  beginGatewayResponse({ socket: {}, headers: { host: 'localhost:1234', 'x-forwarded-proto': 'https', 'x-request-id': 'caller-input' } }, local, new Set());
  assert.match(local.headers['x-request-id'], /^[a-f0-9-]{36}$/);
  assert.equal(local.headers['strict-transport-security'], undefined);
  const secure = response();
  beginGatewayResponse({ socket: {}, headers: { host: 'gateway.example' } }, secure, new Set(['https://gateway.example']));
  assert.equal(secure.headers['strict-transport-security'], 'max-age=31536000');
  assert.notEqual(local.headers['x-request-id'], secure.headers['x-request-id']);
});

test('Gateway CSP restricts connections and frames to self or explicit validated origins', () => {
  const policy = gatewayContentSecurityPolicy({});
  assert.match(policy, /connect-src 'self';/);
  assert.match(policy, /frame-src 'self';/);
  assert.doesNotMatch(policy, /(?:connect|frame)-src[^;]*(?:https:;|http:|wss:)/);
  assert.match(gatewayContentSecurityPolicy({ KCODER_STUDIO_CSP_CONNECT_ORIGINS: 'https://api.example,wss://events.example' }), /wss:\/\/events.example/);
  assert.throws(() => gatewayContentSecurityPolicy({ KCODER_STUDIO_CSP_FRAME_ORIGINS: 'https://user:secret@example/path' }));
});

test('Gateway CSP permits HTTPS product account login without enabling WebSocket or frame access to the issuer', () => {
  for (const key of ['KCODER_STUDIO_RELAY_DEFAULT_URL', 'KCODER_STUDIO_RELAY_ORIGIN', 'KCODER_RELAY_PUBLIC_URL']) {
    const policy = gatewayContentSecurityPolicy({ [key]: 'https://account.example:8451/' });
    assert.match(policy, /connect-src 'self' https:\/\/account\.example:8451;/);
    assert.match(policy, /frame-src 'self';/);
    assert.doesNotMatch(policy, /wss:\/\/account\.example/);
  }
  const policy = gatewayContentSecurityPolicy({ KCODER_STUDIO_RELAY_DEFAULT_URL: 'https://account.example',
    KCODER_STUDIO_RELAY_ORIGIN: 'https://transport.example' });
  assert.match(policy, /connect-src 'self' https:\/\/account\.example;/);
  assert.doesNotMatch(policy, /transport\.example/);
});

test('Gateway CSP never authorizes invalid product account URLs', () => {
  for (const value of ['http://account.example', 'wss://account.example', 'https://user:secret@account.example',
    'https://account.example/path', 'https://account.example?query=1', 'https://account.example#fragment', 'invalid']) {
    assert.match(gatewayContentSecurityPolicy({ KCODER_STUDIO_RELAY_DEFAULT_URL: value }), /connect-src 'self';/);
  }
});
