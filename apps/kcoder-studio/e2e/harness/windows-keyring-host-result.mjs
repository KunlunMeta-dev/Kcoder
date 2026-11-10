import assert from 'node:assert/strict';

export function validateOwnedHostCleanup(value) {
  for (const key of ['safeToRemoveRoot', 'systemEntryAbsenceVerified', 'originalReferencesUndone',
    'originalGroupUndone', 'targetSettingsRestored', 'activeBindingsAbsent']) assert.equal(value[key], true);
  assert.equal(value.referenceCount, 2); assert.equal(value.fileBackendUsed, false);
}

export function validateOwnedHostResult(result, owner, username) {
  assert.equal(result.passed, true); assert.equal(result.scope, 'native_migration_host_keyring');
  assert.equal(result.owner, owner); assert.equal(result.username, username);
  assert.match(result.ownedSid, /^S-1-5-21-[0-9-]+$/);
  assert.equal(result.hostMigrationVerified, true); assert.equal(result.gatewayMigrationVerified, false);
  const first = result.written, second = result.reopened;
  assert.equal(first.stage, 'native_host_group_published_pending_independent_reopen');
  assert.equal(second.stage, 'native_host_reopened_source_offline_and_rolled_back');
  for (const value of [first, second]) {
    assert.equal(value.status, 'passed'); assert.equal(value.targetFilesAndRpcContainNoOriginalValues, true);
    assert.equal(value.oldSourceToolsExecuted, 0); assert.equal(value.modelTurnsStarted, 0);
    assert.equal(value.appServerProcessesClosed, 1);
    assert.ok(Number.isSafeInteger(value.rpcRequests) && value.rpcRequests > 0);
  }
  for (const key of ['hostMigrationVerified', 'forcedKeyring', 'providerAndMcpSameGroup',
    'explicitConsentEnforced', 'applyReceiptDiscardedAndReadReconciled']) assert.equal(first[key], true);
  assert.equal(first.storageQuerySucceeded, true); assert.equal(first.storageFileNodesKnown, false);
  assert.equal(first.publishedCredentials, 2);
  assert.equal(first.nativeAudit.nativeHostPublishedBindingsVerified, true);
  assert.equal(first.nativeAudit.referenceCount, 2); assert.equal(first.nativeAudit.fileBackendUsed, false);
  assert.equal(first.nativeAudit.providerResolved, true); assert.equal(first.nativeAudit.mcpResolved, true);
  assert.equal(first.nativeAudit.mcpDisabled, true);
  for (const key of ['independentHostReopen', 'originalRequestReceiptReconciled', 'sourceOfflineUndo',
    'sourceBytesUnchanged']) assert.equal(second[key], true);
  validateOwnedHostCleanup(second.nativeAudit);
}
