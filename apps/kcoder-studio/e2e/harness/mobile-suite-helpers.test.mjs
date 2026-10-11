import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createMobileLatencyHelpers } from './mobile-latency-helpers.mjs';
import { createMobileRenderProfileHelpers } from './mobile-render-profile-helpers.mjs';
import { createPublicRelayDiagnosticHelpers } from './public-relay-diagnostic-helpers.mjs';

test('latency runs own independent ledgers and immutable evidence snapshots', () => {
  const first = createMobileLatencyHelpers({});
  const second = createMobileLatencyHelpers({});
  const a = first.createNetworkLedger();
  const b = second.createNetworkLedger();
  a.http.push({ status: 200 });
  const snapshot = first.snapshotNetworkEvidence(a);
  a.http[0].status = 503;
  assert.equal(b.http.length, 0);
  assert.equal(snapshot.http[0].status, 200);
  assert.equal(Object.hasOwn(snapshot, 'requestStarts'), false);
  assert.throws(() => { snapshot.http[0].status = 404; }, TypeError);
});

test('profile exports reject traversal and credential material before file access', () => {
  const helpers = createMobileRenderProfileHelpers({});
  assert.deepEqual(helpers.assertSafeBundleRelativePath('assets/app.js', 'fixture'), ['assets', 'app.js']);
  for (const path of ['../outside', '/outside', 'assets/../outside', 'assets\\outside', '.env', 'private-key.pem', 'credentials.json']) {
    assert.throws(() => helpers.assertSafeBundleRelativePath(path, 'fixture'));
  }
});

test('relay diagnostics summarize bounded latency and fingerprint request IDs', () => {
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  const helpers = createPublicRelayDiagnosticHelpers({ sha256 });
  assert.deepEqual(helpers.summarizeLatencyValues([10, 1, 5, 3]), {
    sampleCount: 4, medianMs: 3, p90Ms: 10, maxMs: 10,
  });
  const headers = new Headers({ 'x-request-id': 'synthetic-request-id', 'authorization': 'synthetic-private-header', 'content-type': 'application/json' });
  const result = helpers.summarizeResponseHeaders(headers);
  assert.equal(result.xRequestIdFingerprint, sha256('synthetic-request-id'));
  assert.equal(Object.hasOwn(result, 'authorization'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-request-id'), false);
  assert.equal(helpers.dataSocketDelta({ status: 'captured', dataSocketCount: 2 }, { status: 'captured', dataSocketCount: 5 }), 3);
});
