import assert from 'node:assert/strict';
import test from 'node:test';
import { validateOwnedCoreResult, validateOwnedCoreCleanup } from './windows-keyring-core-result.mjs';
import { keyringAccountSourceReview, validateOwnedKeyringCleanup } from './windows-keyring-account.mjs';
import { prepareSuiteArtifacts } from '../run-all.mjs';
import { suiteEnvironmentNames } from './runner-options.mjs';

function result() {
  return { passed: true, scope: 'config_core_keyring', owner: 'owned', username: 'owned-name', ownedSid: 'S-1-5-21-1-2-3-1000',
    coreStoreVerified: true, coreMigrationVerified: false, hostMigrationVerified: false,
    written: { status: 'passed', stage: 'core_group_published_pending_independent_reopen', fileBackendUsed: false,
      targetFilesContainNoOriginalValues: true, providerAndMcp: true, referenceCount: 2, lostSetReconciledWithoutReplay: true,
      groupReceiptDeliberatelyWithheld: true, mcpImportedDisabled: true, availabilityProbeReadOnly: true, availabilityProbeReads: 7, calls: { set: 2 } },
    reopened: { status: 'passed', stage: 'core_reopened_and_group_undone_pending_delete_reconciliation', fileBackendUsed: false,
      targetFilesContainNoOriginalValues: true, providerResolved: true, mcpResolved: true, originalGroupReceiptReconciledWithoutCallback: true,
      wrongProfileRejectedBeforeBackend: true, groupedRemovalBlocked: true, lostDeleteReachedOs: true, undoingBlocksReinstall: true, calls: { set: 0, delete: 1 } } };
}

test('Core acceptance rejects raw-vault success, plaintext fallback, replay or missing authority proof', () => {
  validateOwnedCoreResult(result(), 'owned', 'owned-name');
  for (const mutate of [v => { v.scope = 'os_backend_only'; }, v => { v.written.calls.set = 3; },
    v => { v.reopened.calls.set = 1; }, v => { v.reopened.fileBackendUsed = true; },
    v => { v.reopened.wrongProfileRejectedBeforeBackend = false; }, v => { v.hostMigrationVerified = true; }]) {
    const bad = result(); mutate(bad); assert.throws(() => validateOwnedCoreResult(bad, 'owned', 'owned-name'));
  }
});

test('Core cleanup requires two original entries inactive and no replay of the lost delete', () => {
  const value = { safeToRemoveRoot: true, systemEntryAbsenceVerified: true, coreStateUndone: true, targetSettingsRestored: true,
    activeBindingsAbsent: true, lostDeleteReconciledWithoutReplay: true, fileBackendUsed: false, referenceCount: 2, calls: { delete: 1 } };
  validateOwnedCoreCleanup(value);
  assert.throws(() => validateOwnedCoreCleanup({ ...value, calls: { delete: 2 } }));
  assert.throws(() => validateOwnedCoreCleanup({ ...value, activeBindingsAbsent: false }));
});

test('a Core preparing intent can prove no backend write without pretending a vault absence read', () => {
  const value = { cleaned: true, owner: 'owned', ownedSid: 'S-1-5-21-1-2-3-1000', accountAbsent: true, profileAbsent: true,
    allJobsStopped: true, vault: { safeToRemoveRoot: true, systemEntryAbsenceVerified: false,
      noBackendWriteDispatched: true, referenceCount: 0, coreCaseNotCompleted: true } };
  validateOwnedKeyringCleanup(value, 'owned', 'config-core');
  assert.throws(() => validateOwnedKeyringCleanup(value, 'owned', 'raw'));
  assert.throws(() => validateOwnedKeyringCleanup({ ...value, vault: { ...value.vault, referenceCount: 2 } }, 'owned', 'config-core'));
});

test('Core scope pins its full helper, forwards only its gates and cannot rebuild shared application outputs', async () => {
  const source = 'suites/gateway/windows-keyring-core.e2e.mjs', calls = [];
  await prepareSuiteArtifacts([source], { run: async (...args) => { calls.push(args); } });
  assert.deepEqual(calls, []);
  assert.ok(suiteEnvironmentNames(source).includes('KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_REVIEW_SHA256'));
  const raw = await keyringAccountSourceReview(), core = await keyringAccountSourceReview('config-core');
  assert.notEqual(raw.sourceSha256, core.sourceSha256);
  assert.equal(new Set(core.files.map(f => f.path)).size, core.files.length);
  assert.ok(core.files.some(f => f.path.endsWith('windows_imported_credential_security/core.rs')));
  assert.ok(core.files.some(f => f.path.endsWith('windows-keyring-core.e2e.mjs')));
});
