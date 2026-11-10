import assert from 'node:assert/strict';

export const CROSS_HOST_CONTENT_VERSION = 'cross-host-contents/v1';
export const CROSS_HOST_CONTENT_CAPABILITIES = Object.freeze({
  memory: ['migrationMemoryV1'],
  definitions: ['migrationDefinitionsV1'],
  instructions: ['migrationInstructionSourcesV1', 'migrationSourceTransferInstructionsV1'],
  plugin: ['migrationLocalPluginsV1', 'migrationSourceTransferPluginsV1'],
  private: ['migrationSourceCredentialSourcesV1'],
});

/** Ordinary RPC deliberately hides private owner capabilities; their dedicated lane checks them. */
export function requireCrossHostContentCapabilities(capabilities, selected = Object.keys(CROSS_HOST_CONTENT_CAPABILITIES)) {
  assert.ok(capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities));
  assert.ok(Array.isArray(selected) && selected.length > 0 && new Set(selected).size === selected.length);
  const missing = [];
  for (const kind of selected) {
    assert.ok(Object.hasOwn(CROSS_HOST_CONTENT_CAPABILITIES, kind), 'unknown content class cannot widen this suite');
    for (const capability of CROSS_HOST_CONTENT_CAPABILITIES[kind]) if (capabilities[capability] !== true) missing.push(capability);
  }
  if (missing.length) throw new Error(`UNMET_PREREQUISITE: frozen Native lacks reviewed content capabilities: ${missing.join(',')}`);
  return { version: CROSS_HOST_CONTENT_VERSION, selected: [...selected], required: [...new Set(selected.flatMap(kind => CROSS_HOST_CONTENT_CAPABILITIES[kind]))] };
}

export function crossHostContentSelection(queryKind, sourceId) {
  assert.ok(['memory', 'definitions'].includes(queryKind));
  assert.ok(typeof sourceId === 'string' && sourceId.length > 0 && Buffer.byteLength(sourceId) <= 256 && !/[\u0000-\u001f\u007f]/.test(sourceId));
  // The source query supplies an actual Native asset grant, not an inferred category/path.
  return { kind: 'assets', sourceId };
}

/** A receipt or a skipped class cannot stand in for ordinary publication and original Undo. */
export function validateCrossHostContentEvidence(details) {
  assert.equal(details.contentVersion, CROSS_HOST_CONTENT_VERSION);
  assert.equal(details.dedicatedAccountIsolationClaim, false);
  assert.equal(details.results.length, 2);
  const expectedKinds = ['definitions', 'definitions', 'instructions', 'instructions', 'memory', 'memory', 'plugin', 'private'];
  const directions = new Set();
  for (const result of details.results) {
    assert.ok(['windows->linux', 'linux->windows'].includes(result.direction)); assert.ok(!directions.has(result.direction)); directions.add(result.direction);
    assert.deepEqual(result.contents.map(row => row.kind).sort(), expectedKinds);
    const jobs = new Set();
    for (const row of result.contents) {
      assert.equal(row.direction, result.direction); assert.ok(row.jobId && !jobs.has(row.jobId)); jobs.add(row.jobId);
      assert.ok(row.requestId && row.adoptionId);
      if (row.kind === 'private') {
        assert.equal(row.publishedReferences, 2); assert.equal(row.sourceGoneBeforePublication, true);
        assert.equal(row.acceptedPreparationReopened, true); assert.equal(row.ordinaryOwnedUndo, true);
        assert.equal(row.targetSettingsRestored, true); assert.equal(row.keyReleased, true);
        assert.equal(row.backendMode, 'file'); assert.equal(row.osKeyringClaim, false);
      } else {
        assert.ok(row.importedItems > 0); assert.ok(['completed', 'completed_with_issues'].includes(row.publishedStatus));
        assert.equal(row.sourceAbsentBeforeAdoption, true); assert.equal(row.reopenedOriginalPlan, true); assert.equal(row.undoStatus, 'rolled_back');
        assert.equal(row.defaultDisabled ?? row.disabled, true);
        if (row.kind === 'memory') assert.equal(row.factsVerified, false);
        if (row.kind === 'instructions') assert.equal(row.dataOnlyTargetMapping, true);
      }
    }
  }
  return { version: CROSS_HOST_CONTENT_VERSION, directions: 2, publishedAndUndoneBatches: 16, additionalClasses: 5, osKeyringClaim: false, dedicatedAccountIsolationClaim: false };
}

/** A pending close gets read-only reconciliation on its original selector, never another close. */
export async function releaseCrossHostSourceSession({ call, until, session }) {
  const acknowledgement = await call('source-session', 'close', session);
  assert.ok(['released', 'pending', 'unknown'].includes(acknowledgement.status));
  if (acknowledgement.status !== 'released') await until(async () => {
    const value = await call('source-session', 'read', session);
    return value.status === 'released' && value.launching === false && value.ownedChildren === 0 ? value : false;
  }, 'original source session release observation', 15000);
  return { sessionId: session.sessionId, status: 'released' };
}

/** Observation deadlines never authorize replay; a proven active original attempt gets reads only. */
export async function awaitCrossHostReady({ call, until, pair, label }) {
  let last = null;
  const poll = async () => {
    const value = await call('source-transfer', 'read', pair, false, true);
    if (!value) return false; last = value;
    assert.ok(!['failed', 'cancelled', 'interrupted'].includes(value.result.phase), `${label}: terminal failure cannot be retried into a pass: ${JSON.stringify(value)}`);
    return value.result.phase === 'ready' ? value : false;
  };
  try { return await until(poll, label, 30000); }
  catch (error) {
    if (!error.message.startsWith('Owned cross-host deadline:')) throw error;
    const reconciled = await poll(); if (reconciled) return reconciled;
    const active = last?.coordinatorState === 'running' || last?.result?.sourceCapture?.status === 'running' || last?.result?.targetWorkerRunning === true;
    if (active) {
      try { return await until(poll, `${label} (same active attempt read-only)`, 90000); }
      catch (continued) { throw new Error(`${continued.message}; original attempt last observation: ${JSON.stringify(last)}`, { cause: continued }); }
    }
    throw new Error(`${error.message}; original attempt last observation: ${JSON.stringify(last)}`, { cause: error });
  }
}
