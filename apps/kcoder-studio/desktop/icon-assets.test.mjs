import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeIcns, generateDesktopIcons } from './generate-icons.mjs';

test('ICNS canonicalization preserves payloads and rejects malformed containers', () => {
  const chunk = type => Buffer.concat([Buffer.from(type), Buffer.from([0, 0, 0, 9, 42])]);
  const header = Buffer.concat([Buffer.from('icns'), Buffer.from([0, 0, 0, 26])]);
  const canonical = Buffer.concat([header, chunk('ic07'), chunk('ic08')]);
  assert.deepEqual(canonicalizeIcns(Buffer.concat([header, chunk('ic08'), chunk('ic07')])), canonical);
  assert.deepEqual(canonicalizeIcns(canonical), canonical);
  assert.throws(() => canonicalizeIcns(canonical.subarray(0, 25)), /Invalid ICNS/);
  const invalid = Buffer.from(canonical);
  invalid.writeUInt32BE(0, 12);
  assert.throws(() => canonicalizeIcns(invalid), /Invalid ICNS chunk length/);
});

test('all native, floating-panel and browser icons reproduce the supplied source image', async () => {
  const result = await generateDesktopIcons({ check: true });
  assert.equal(result.files, 20);
  assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
});
