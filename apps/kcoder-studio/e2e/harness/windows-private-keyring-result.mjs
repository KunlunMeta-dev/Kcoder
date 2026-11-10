import assert from 'node:assert/strict';

export function validatePrivateKeyringCleanup(value) {
  assert.equal(value.safeToRemoveRoot, true);
  if (value.noPrivateWriteDispatched === true) {
    assert.equal(value.referenceCount, 0); assert.equal(value.privateCaseNotCompleted, true); return;
  }
  for (const name of ['systemEntryAbsenceVerified', 'originalGroupUndone', 'targetSettingsRestored']) assert.equal(value[name], true);
  assert.equal(value.referenceCount, 4); assert.equal(value.recipientCount, 2); assert.equal(value.fileBackendUsed, false);
}
export function validatePrivateKeyringResult(value, owner, username) {
  assert.equal(value.passed, true); assert.equal(value.scope, 'native_private_transfer_keyring');
  assert.equal(value.owner, owner); assert.equal(value.username, username);
  assert.match(value.ownedSid, /^S-1-5-21-[0-9-]+$/);
  assert.equal(value.hostMigrationVerified, true); assert.equal(value.privateTransferVerified, true);
  assert.equal(value.gatewayMigrationVerified, false); assert.equal(value.coreMigrationVerified, false);
  const first = value.written, second = value.reopened;
  assert.equal(first.stage, 'private_bundle_published_pending_independent_logon');
  assert.equal(second.stage, 'private_bundle_reopened_undone_and_keys_released');
  assert.equal(first.forcedKeyring, true); assert.equal(first.privatePrepareCalls, 1); assert.equal(second.privatePrepareCalls, 0);
  for (const result of [first, second]) {
    assert.equal(result.status, 'passed'); assert.equal(result.offers, 2); assert.equal(result.publishedReferences, 4);
    assert.equal(result.originalIntentRecovered, true); assert.equal(result.sourceOffline, true);
    assert.equal(result.targetFilesAndRpcContainNoOriginalValues, true); assert.equal(result.oldToolsExecuted, 0);
    assert.ok(result.processes.length > 0 && result.processes.every(row => row.closed && row.exitCode === 0));
  }
  assert.equal(first.nativeAudit.vaultValuesMatched, true); assert.equal(first.nativeAudit.referenceCount, 4);
  assert.equal(first.nativeAudit.recipientCount, 2); assert.equal(first.nativeAudit.fileBackendUsed, false);
  assert.equal(first.modelInferenceRequests, 0); assert.equal(second.modelTurnsStarted, 0);
  assert.equal(second.independentHostReopen, true); assert.equal(second.transportKeysReleased, true);
  assert.deepEqual(value.jobs.map(job => job.action), ['bootstrap', 'write', 'reopen']);
  assert.equal(new Set(value.jobs.map(job => job.logonLuid)).size, 3);
  for (const job of value.jobs) {
    assert.equal(job.sid, value.ownedSid); assert.equal(job.logonType, 2); assert.equal(job.elevated, false);
    assert.equal(job.profileHiveLoaded, true); assert.equal(job.stopped, true);
  }
  validatePrivateKeyringCleanup(second.nativeAudit);
}
