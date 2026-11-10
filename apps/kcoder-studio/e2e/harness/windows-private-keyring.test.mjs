import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyringJson, keyringSaveIntent, validateKeyringIntent, keyringNoValues } from './windows-private-keyring-state.mjs';
import { validatePrivateKeyringResult, validatePrivateKeyringCleanup } from './windows-private-keyring-result.mjs';
import { runPrivateKeyringReopen } from './windows-private-keyring-reopen.mjs';
import { keyringAccountSourceReview, runOwnedKeyringAccount } from './windows-keyring-account.mjs';
import { prepareSuiteArtifacts } from '../run-all.mjs';
import { suiteEnvironmentNames } from './runner-options.mjs';

const owner = '10000000-0000-4000-8000-000000000000';
function intent() {
  return { version: 1, owner, requestId: '10000000-0000-4000-8000-000000000001',
    offers: ['10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003'],
    sourceSha256: ['a','b','c','d'].map(letter => letter.repeat(64)), providerNames: ['WindowsPrivateProvider0', 'WindowsPrivateProvider1'],
    mcpNames: ['windows-private-notes-2', 'windows-private-notes-3'], writeDispatched: false, originalIntent: null,
    jobId: 'mig-' + 'b'.repeat(32), applyRequestId: '10000000-0000-4000-8000-000000000005', applySequence: null,
    undoRequestId: '10000000-0000-4000-8000-000000000004', undoSequence: null, undoDispatched: false, phase: 'bound' };
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'owned-private-keyring-unit-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
test('original offer set, selection digests and first Native prepare receipt cannot be changed on reopen', async t => {
  const root = await directory(t), value = intent();
  await keyringSaveIntent(root, value, true);
  const bad = structuredClone(value); bad.offers[1] = '10000000-0000-4000-8000-000000000005';
  await assert.rejects(keyringSaveIntent(root, bad));
  value.phase = 'prepared'; value.writeDispatched = true;
  value.originalIntent = { phase: 'prepared', requestId: value.requestId, jobId: value.jobId, offerIds: value.offers,
    expectedSequence: 3, originalPlanId: 'original', planId: 'private', consent: { apiKeys: true, mcpPrivateFields: true } };
  await keyringSaveIntent(root, value);
  const altered = structuredClone(value); altered.originalIntent.expectedSequence++;
  await assert.rejects(keyringSaveIntent(root, altered));
  assert.deepEqual(validateKeyringIntent(await keyringJson(join(root, 'private-keyring-intent.json')), owner), value);
});
test('an interrupted publication is retained without opening Native, reading vault entries or pretending cleanup succeeded', async t => {
  const root = await directory(t), value = intent(); value.phase = 'apply_dispatched'; value.writeDispatched = true;
  await keyringSaveIntent(root, value, true); let auditCalls = 0;
  await assert.rejects(runPrivateKeyringReopen({ root, owner, cleanup: true, audit() { auditCalls++; } }), /publication_unknown/);
  assert.equal(auditCalls, 0); assert.equal((await keyringJson(join(root, 'private-keyring-intent.json'))).phase, 'apply_dispatched');
});
test('a missing intent delegates only to the original native pre-effect admission proof', async t => {
  const root = await directory(t), calls = [];
  const result = await runPrivateKeyringReopen({ root, owner, cleanup: true, audit(mode) {
    calls.push(mode); return { noPrivateWriteDispatched: true };
  } });
  assert.deepEqual(calls, ['--private-unused-final']); assert.equal(result.noPrivateWriteDispatched, true);
});
test('the whole owned target profile is checked, including private sidecars outside public settings', async t => {
  const root = await directory(t), secret = 'SYNTHETIC_PRIVATE_KEYRING_VALUE';
  await mkdir(join(root, 'private-sidecar')); await writeFile(join(root, 'settings.json'), '{}');
  await writeFile(join(root, 'private-sidecar', 'empty.lock'), ''); await keyringNoValues(root, [secret]);
  await writeFile(join(root, 'private-sidecar', 'unexpected.json'), secret);
  await assert.rejects(keyringNoValues(root, [secret]), /profile_plaintext/);
  await rm(join(root, 'private-sidecar', 'unexpected.json'));
  await writeFile(join(root, 'private-sidecar', 'private-key.bin'), 'SYNTHETIC_NON_SOURCE_KEY_BYTES');
  await assert.rejects(keyringNoValues(root, [secret]), /file_key_fallback/);
});
test('normal-logon private scope requires its complete source review and does not prepare unrelated products', async () => {
  const review = await keyringAccountSourceReview('private-rpc');
  assert.ok(review.files.some(row => row.path.endsWith('windows_private_credential_audit/audit.rs')));
  assert.ok(review.files.some(row => row.path.endsWith('windows-private-keyring-reopen.mjs')));
  await assert.rejects(runOwnedKeyringAccount({ spawnOwned() { assert.fail('No unreviewed account may start'); } },
    { consent: '1', scenario: 'private-rpc', mode: 'roundtrip', target: 'owned-host', parent: 'D:\\' }));
  await prepareSuiteArtifacts(['suites/gateway/windows-private-keyring.e2e.mjs'], { run() { assert.fail('No installer or shared build'); } });
  const names = suiteEnvironmentNames('suites/gateway/windows-private-keyring.e2e.mjs');
  for (const name of ['KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_REVIEW_SHA256', 'KCODER_E2E_WINDOWS_KEYRING_HOST_CLI_SHA256'])
    assert.ok(names.includes(name));
});
test('only original four-reference and two-recipient absence can authorize a completed private cleanup', () => {
  const value = { safeToRemoveRoot: true, systemEntryAbsenceVerified: true, originalGroupUndone: true,
    targetSettingsRestored: true, referenceCount: 4, recipientCount: 2, fileBackendUsed: false };
  validatePrivateKeyringCleanup(value);
  for (const changed of [{ referenceCount: 2 }, { recipientCount: 1 }, { systemEntryAbsenceVerified: false }, { fileBackendUsed: true }])
    assert.throws(() => validatePrivateKeyringCleanup({ ...value, ...changed }));
  assert.throws(() => validatePrivateKeyringResult({ passed: true, scope: 'os_backend_only' }, owner, 'fixture'));
});
