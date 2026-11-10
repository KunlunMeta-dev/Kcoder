import assert from 'node:assert/strict';
import test from 'node:test';
import { PACKAGED_FETCH_CASES, packagedFetchOptions } from './packaged-fetch-case.mjs';
const identity = { KCODER_E2E_PACKAGED_DIR: '/owned/new-package', KCODER_E2E_PACKAGED_COMMIT: 'a'.repeat(40), KCODER_E2E_PACKAGED_CLI_SHA256: 'b'.repeat(64) };

test('default Python source and legacy evidence identity remain unchanged', () => {
  const result = packagedFetchOptions({ KCODER_E2E_PACKAGED_DIR: '/owned/e205' });
  assert.equal(result.caseId, 'python-asyncio');
  assert.equal(result.url, 'https://docs.python.org/3/library/asyncio-task.html');
  assert.equal(result.expectedCommit, 'e2051ca9ead60fac9d4b2ae8fb5fdb78444bc2c8');
  assert.equal(result.explicitPackageIdentity, false);
});

test('both fixed cases accept a new exact package identity without changing their URL', () => {
  for (const caseId of Object.keys(PACKAGED_FETCH_CASES)) {
    const result = packagedFetchOptions({ ...identity, KCODER_E2E_FETCH_CASE: caseId });
    assert.equal(result.expectedCommit, identity.KCODER_E2E_PACKAGED_COMMIT);
    assert.equal(result.expectedCliSha256, identity.KCODER_E2E_PACKAGED_CLI_SHA256);
    assert.equal(result.url, PACKAGED_FETCH_CASES[caseId].url);
    assert.equal(result.explicitPackageIdentity, true);
  }
});

test('TWZ selection is exact and requires an explicit final artifact identity', () => {
  const result = packagedFetchOptions({ ...identity, KCODER_E2E_FETCH_CASE: 'twz-gj21' });
  assert.equal(result.url, 'https://www.twz.com/air/stealthy-gj-21-drone-has-launched-and-recovered-from-type-076-amphibious-assault-ship-china-claims');
  assert.throws(() => packagedFetchOptions({ KCODER_E2E_PACKAGED_DIR: '/owned/old', KCODER_E2E_FETCH_CASE: 'twz-gj21' }), /requires explicit/);
});

for (const extra of [
  { KCODER_E2E_FETCH_CASE: 'https://example.com/' },
  { KCODER_E2E_FETCH_CASE: '../twz-gj21' },
  { KCODER_E2E_FETCH_CASE: 'toString' },
  { KCODER_E2E_FETCH_URL: 'http://127.0.0.1/private' },
  { KCODER_E2E_PACKAGED_COMMIT: '' },
  { KCODER_E2E_PACKAGED_COMMIT: 'short' },
  { KCODER_E2E_PACKAGED_CLI_SHA256: 'not-a-sha' },
  { KCODER_E2E_PACKAGED_DIR: '../relative' },
]) test(`rejects unsupported or ambiguous inputs: ${JSON.stringify(extra)}`, () => {
  assert.throws(() => packagedFetchOptions({ ...identity, ...extra }));
});

test('a half identity cannot silently fall back to the old package', () => {
  assert.throws(() => packagedFetchOptions({ KCODER_E2E_PACKAGED_DIR: '/owned/new', KCODER_E2E_PACKAGED_COMMIT: 'c'.repeat(40) }), /both packaged/);
  assert.throws(() => packagedFetchOptions({ KCODER_E2E_PACKAGED_DIR: '/owned/new', KCODER_E2E_PACKAGED_CLI_SHA256: 'd'.repeat(64) }), /both packaged/);
});
