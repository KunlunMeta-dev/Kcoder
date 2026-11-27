import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { privatePrefix, privateUntil, readPrivateFixture, windowsPrivateNativeOwner } from './windows-private-credential-native.mjs';
import { validatePrivateFixture } from './windows-private-credential-review.mjs';
import { keyringJson, keyringSaveIntent, validateKeyringIntent, keyringNoValues, assertKeyringSamePreparation } from './windows-private-keyring-state.mjs';

export async function runPrivateKeyringReopen({ root, binary, environment, owner, audit, cleanup = false }) {
  let intent;
  try { intent = validateKeyringIntent(await keyringJson(join(root, 'private-keyring-intent.json')), owner); }
  catch (error) {
    if (error.code !== 'ENOENT' || !cleanup) throw error;
    return { status: 'passed', nativeAudit: await audit('--private-unused-final'), noPrivateWriteDispatched: true };
  }
  if (!intent.writeDispatched) {
    assert.equal(cleanup, true);
    return { status: 'passed', nativeAudit: await audit('--private-unused-final'), noPrivateWriteDispatched: true };
  }
  // An incomplete first logon remains owned and retained; cleanup may not guess or replay publication.
  assert.ok(['published', 'undo_dispatched', 'undone', 'released'].includes(intent.phase), 'private_keyring_publication_unknown');
  assert.ok(intent.originalIntent !== null);
  const values = validatePrivateFixture(await readPrivateFixture(join(root, 'private-fixture.json')), owner);
  const natives = windowsPrivateNativeOwner({ root, binary, environment, values });
  let target;
  try {
    const profile = join(root, 'private-target-profile');
    target = await natives.start(cleanup ? 'target-cleanup' : 'target-independent-logon', profile, join(root, 'empty-claude'));
    const peer = await target.rpc(privatePrefix + 'peer/recover-target', { requestId: intent.requestId });
    const params = { requestId: intent.requestId, peerRef: peer.peerRef, jobId: intent.jobId };
    const original = await target.rpc(privatePrefix + 'target/private/prepare-status', params);
    assertKeyringSamePreparation(original, intent.originalIntent);
    await assert.rejects(access(join(root, 'private-codex')), { code: 'ENOENT' });
    let state = await target.rpc('migration/batch/read', { jobId: intent.jobId });
    const items = await target.rpc('migration/items', { jobId: intent.jobId, pageIndex: 0 });
    const retained = items.items.filter(item => item.status === 'requires_action');
    assert.equal(retained.length, 1); assert.equal(retained[0].category, 'provider');
    assert.equal(state.state.job.hasUnconfirmedOutcomes, false);
    if (intent.phase === 'published') {
      assert.equal(state.workerRunning, false); assert.equal(state.state.job.committedItems, 4);
      assert.equal(state.state.batch.committedActions, state.state.batch.totalActions);
      assert.equal(state.state.batch.unresolvedActions, 0);
      assert.equal((await audit('--private-capture')).vaultValuesMatched, true);
      // The rollback request is fixed durably before its one permitted send.
      intent.undoSequence = state.state.job.sequence;
      intent.phase = 'undo_dispatched'; intent.undoDispatched = true; await keyringSaveIntent(root, intent);
      await target.rpc('migration/batch/run', { jobId: intent.jobId, expectedSequence: intent.undoSequence,
        planId: original.planId, requestId: intent.undoRequestId, mode: 'rollback' });
    }
    if (intent.phase === 'undo_dispatched') {
      // Lost rollback acknowledgement is observed through the original job, never resent.
      state = await privateUntil(() => target.rpc('migration/batch/read', { jobId: intent.jobId }), row => !row.workerRunning, 'keyring_undo');
      assert.equal(state.state.job.status, 'rolled_back'); assert.equal(state.state.job.hasUnconfirmedOutcomes, false);
      assert.equal(state.state.batch.unresolvedActions, 0);
      assert.equal(state.state.credentialPlans.length, 2); assert.ok(state.state.credentialPlans.every(plan => plan.phase === 'undone'));
      const mcp = await target.rpc('migration/batch/mcp/credential/read', { jobId: intent.jobId });
      assert.equal(mcp.plans.length, 2); assert.ok(mcp.plans.every(plan => plan.phase === 'undone'));
      intent.phase = 'undone'; await keyringSaveIntent(root, intent);
    }
    for (const offerId of intent.phase === 'released' ? [] : intent.offers) {
      // Native reconciles the original release receipt and key fingerprint on an interrupted cleanup.
      const release = await target.rpc(privatePrefix + 'target/private/release', { ...params, offerId });
      assert.equal(release.keyReleased, true);
    }
    intent.phase = 'released'; await keyringSaveIntent(root, intent);
    const nativeAudit = await audit('--private-final');
    assert.equal(nativeAudit.systemEntryAbsenceVerified, true);
    for (const leaf of ['settings.json', 'credentials.json']) {
      const bytes = await readFile(join(profile, leaf));
      for (const value of values) assert.equal(bytes.includes(Buffer.from(value)), false, 'private_keyring_target_value');
    }
    await assert.rejects(access(join(root, 'source-tool-must-not-run')), { code: 'ENOENT' });
    const afterUndo = await target.rpc('migration/items', { jobId: intent.jobId, pageIndex: 0 });
    for (const original of retained) assert.equal(afterUndo.items.find(item => item.id === original.id)?.status, original.status);
    await target.stop();
    await keyringNoValues(profile, values);
    assert.ok(natives.processes.every(row => row.privatePrepareCalls === 0));
    return { status: 'passed', stage: 'private_bundle_reopened_undone_and_keys_released', independentHostReopen: true,
      originalIntentRecovered: true, sourceOffline: true, publishedReferences: 4, offers: 2, transportKeysReleased: true,
      targetFilesAndRpcContainNoOriginalValues: true, nativeAudit, privatePrepareCalls: 0, processes: natives.processes,
      oldToolsExecuted: 0, modelTurnsStarted: 0 };
  } finally { await natives.close(); }
}
