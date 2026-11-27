import test from 'node:test';
import assert from 'node:assert/strict';
import { privatePayload, canonical, httpsUrl, boundedText, MAX_JSON_BYTES } from '../src/validation.mjs';

test('public payloads reject explicit credential aliases while allowing public key and reference metadata', () => {
  for (const name of ['authToken', 'id_token', 'apiSecret', 'webhookSecret', 'signSecret', 'secretKey', 'privateKey',
    'signing_key', 'secretValue', 'x-api-key', 'bot_access_token']) {
    assert.throws(() => privatePayload({ metadata: { [name]: 'inert-private-fixture' } }), /SECRET_IN_PUBLIC_PAYLOAD/, name);
  }
  const metadata = { publicKey: 'public-material', secretRef: 'opaque-ref', tokenCount: 5, monkey: 'public', signingKeyId: 'public-id' };
  assert.deepEqual(JSON.parse(privatePayload(metadata)), metadata);
});

test('the public payload byte budget is checked before serializing an oversized string', t => {
  const stringify = JSON.stringify;
  let largestString = 0;
  t.mock.method(JSON, 'stringify', value => {
    if (typeof value === 'string') largestString = Math.max(largestString, value.length);
    return stringify(value);
  });
  assert.throws(() => privatePayload({ blob: 'x'.repeat(2 * 1024 * 1024) }), /PAYLOAD_TOO_LARGE/);
  assert.ok(largestString < MAX_JSON_BYTES);
});

test('the public payload byte limit includes JSON escaping and preserves the canonical boundary', () => {
  const overhead = Buffer.byteLength(JSON.stringify({ value: '' }));
  assert.equal(Buffer.byteLength(privatePayload({ value: 'x'.repeat(MAX_JSON_BYTES - overhead) })), MAX_JSON_BYTES);
  assert.throws(() => privatePayload({ value: 'x'.repeat(MAX_JSON_BYTES - overhead + 1) }), /PAYLOAD_TOO_LARGE/);
  assert.throws(() => privatePayload({ value: '\u0000'.repeat(MAX_JSON_BYTES / 4) }), /PAYLOAD_TOO_LARGE/);
  assert.equal(canonical({ z: 1, a: { value: 'kept' } }), '{"a":{"value":"kept"},"z":1}');
});

test('hostnames compare without DNS case sensitivity while explicit ports and trailing-dot authorities retain their contract', () => {
  assert.equal(httpsUrl('https://EXAMPLE.COM:8443/path', { allowedHosts: ['Example.COM'] }).port, '8443');
  assert.throws(() => httpsUrl('https://example.com/', { allowedHosts: ['example.com:8443'] }), /UNAPPROVED_HOST/);
  assert.throws(() => httpsUrl('https://example.com./', { allowedHosts: ['example.com'] }), /UNAPPROVED_HOST/);
  assert.throws(() => httpsUrl('http://127.0.0.2/', { allowedHosts: ['127.0.0.2'], allowLoopback: true }), /UNSAFE_URL/);
  assert.throws(() => httpsUrl('https://127.0.0.1/', { allowedHosts: ['example.com'] }), /UNAPPROVED_HOST/);
  assert.equal(httpsUrl('https://127.0.0.1/', { allowedHosts: ['127.0.0.1'] }).hostname, '127.0.0.1');
  assert.equal(httpsUrl('http://127.0.0.1/', { allowedHosts: ['127.0.0.1'], allowLoopback: true }).protocol, 'http:');
});

test('malformed text has an explicit type diagnostic and undefined remains outside the canonical contract', () => {
  assert.throws(() => boundedText(42), /INVALID_TEXT/);
  assert.throws(() => canonical({ optional: undefined }), /INVALID_JSON_VALUE/);
  assert.equal(canonical(Object.assign(Object.create(null), { value: 'kept' })), '{"value":"kept"}');
});
