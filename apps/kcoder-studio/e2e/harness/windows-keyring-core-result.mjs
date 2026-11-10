import assert from 'node:assert/strict';

export function validateOwnedCoreResult(result, owner, username) {
  assert.equal(result.passed, true); assert.equal(result.scope, 'config_core_keyring');
  assert.equal(result.owner, owner); assert.equal(result.username, username);
  assert.match(result.ownedSid, /^S-1-5-21-[0-9-]+$/);
  assert.equal(result.coreStoreVerified, true);
  assert.equal(result.coreMigrationVerified, false); assert.equal(result.hostMigrationVerified, false);
  const first = result.written, second = result.reopened;
  assert.equal(first.stage, 'core_group_published_pending_independent_reopen');
  assert.equal(second.stage, 'core_reopened_and_group_undone_pending_delete_reconciliation');
  for (const value of [first, second]) {
    assert.equal(value.status, 'passed'); assert.equal(value.fileBackendUsed, false);
    assert.equal(value.targetFilesContainNoOriginalValues, true);
  }
  assert.equal(first.referenceCount, 2); assert.equal(first.providerAndMcp, true);
  assert.equal(first.lostSetReconciledWithoutReplay, true); assert.equal(first.groupReceiptDeliberatelyWithheld, true);
  assert.equal(first.mcpImportedDisabled, true); assert.equal(first.availabilityProbeReadOnly, true);
  assert.ok(Number.isSafeInteger(first.availabilityProbeReads) && first.availabilityProbeReads > 0);
  assert.equal(first.calls.set, 2);
  for (const name of ['providerResolved', 'mcpResolved', 'originalGroupReceiptReconciledWithoutCallback',
    'wrongProfileRejectedBeforeBackend', 'groupedRemovalBlocked', 'lostDeleteReachedOs', 'undoingBlocksReinstall']) assert.equal(second[name], true);
  assert.equal(second.calls.set, 0); assert.equal(second.calls.delete, 1);
}

export function validateOwnedCoreCleanup(value) {
  for (const key of ['safeToRemoveRoot', 'systemEntryAbsenceVerified', 'coreStateUndone',
    'targetSettingsRestored', 'activeBindingsAbsent', 'lostDeleteReconciledWithoutReplay']) assert.equal(value[key], true);
  assert.equal(value.fileBackendUsed, false); assert.equal(value.referenceCount, 2);
  assert.equal(value.calls.delete, 1);
}
