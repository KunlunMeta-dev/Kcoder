import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { nativeCodeFixture, pollNative, saveNativeCodeWorkflow, serviceRequest, setNativeCodeFeature,
  startNativeCodeManager, startNativeCodeUi } from '../../harness/native-code-service.mjs';
import { repoRoot, requireExecutable, runE2E } from '../../harness/run-context.mjs';

await runE2E(import.meta.url, {
  testId: 'native-code-feature-off-cannot-arm-and-live-disable-retires-exact-owner', tier: 'full-integration',
  modelPolicy: 'Actual isolated nonprivileged Linux UID and native signed Code scope; real original API/issuer/Runtime/pidfd, no model or platform claim',
  processSignalTimeoutMs: 15_000,
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'current native CLI');
  const fixture = await nativeCodeFixture(context, binary);
  const ui = await startNativeCodeUi(context, fixture, 'native-code-boundaries-ui');
  const source = await saveNativeCodeWorkflow(ui, 'OWNED_DISABLED_CODE', 60_000);
  const manager = await startNativeCodeManager(context, fixture, 'native-code-boundaries-manager');
  const prepare = (operationId) => ui.rpc('integrations/services/code/prepare', serviceRequest(ui.scope, {
    purpose: 'native_saved_code_service', explicitBackgroundConsent: true, expiresInMs: 300_000, codeWorkflow: source,
  }, { operationId }));
  const prepared = await prepare(`boundaries-prepare-${context.seed}`);
  const leaseId = prepared.intent.leaseId;
  const denied = async (method, request) => {
    const reply = await ui.client.request(method, request);
    assert.ok(reply.error, 'Original native denial must be returned, not an accepted-but-empty result');
    return reply.error;
  };
  const wrongScope = serviceRequest({ ...ui.scope, accountId: 'forged-account-never-authority' }, { leaseId },
    { operationId: `boundaries-wrong-scope-${context.seed}`, expectedRevision: prepared.revision });
  const scopeDenied = await denied('integrations/services/code/start', wrongScope);
  const injected = await denied('integrations/services/code/start', serviceRequest(ui.scope,
    { leaseId, trusted: true, publicKey: 'caller-must-not-supply-an-issuer' },
    { operationId: `boundaries-injected-authority-${context.seed}`, expectedRevision: prepared.revision }));
  const afterInvalid = await ui.rpc('integrations/services/code/read', serviceRequest(ui.scope, { leaseId }));
  assert.deepEqual(afterInvalid.record, prepared, 'Forged scope and authority fields cannot mutate a lease');
  await setNativeCodeFeature(fixture, false);
  const disabledStartOperation = `boundaries-disabled-start-${context.seed}`;
  const disabled = await denied('integrations/services/code/start', serviceRequest(ui.scope, { leaseId },
    { operationId: disabledStartOperation, expectedRevision: prepared.revision }));
  const afterDisabled = await ui.rpc('integrations/services/code/read', serviceRequest(ui.scope, { leaseId }));
  const operationReply = await ui.rpc('integrations/operation/read', serviceRequest(ui.scope, { operationId: disabledStartOperation }));
  assert.equal(operationReply.status, 'completed');
  const disabledOperation = operationReply.result;
  // Revoke is deliberately available with the feature off, even if an older
  // binary has already armed the erroneous enable intent. No start is retried.
  const revokedOff = await ui.rpc('integrations/services/code/revoke', serviceRequest(ui.scope, { leaseId },
    { operationId: `boundaries-off-revoke-${context.seed}`, expectedRevision: afterDisabled.record.revision }));
  const firstProof = { source: 'actual_native_code_api', scopeDenied, injected, disabled, recordBefore: prepared,
    recordAfterDisabled: afterDisabled.record, grantAfterDisabled: afterDisabled.grant,
    disabledOperation, revokedWhileOff: revokedOff, originalStartWasNotReplayed: true };
  await context.writeArtifactJson('native-code-disabled-start-proof.json', firstProof);
  assert.deepEqual(afterDisabled.record, prepared, 'Disabled START must reject before arming enabled or changing its original revision');
  assert.equal(disabledOperation.receipt, null, 'Disabled START must not create an executing operation before source validation');
  assert.equal(revokedOff.record.enabled, false);
  assert.equal(revokedOff.grant.status, 'revoked');
  await setNativeCodeFeature(fixture, true);
  const livePrepared = await prepare(`boundaries-live-prepare-${context.seed}`);
  const liveLease = livePrepared.intent.leaseId;
  const liveRequest = serviceRequest(ui.scope, { leaseId: liveLease },
    { operationId: `boundaries-live-start-${context.seed}`, expectedRevision: livePrepared.revision });
  const live = await ui.rpc('integrations/services/code/start', liveRequest);
  assert.equal(live.ready.modelCalls, 0);
  assert.ok(live.ready.acceptance?.taskId);
  const actualOwner = await manager.attach(liveLease);
  assert.equal(actualOwner.alive, true);
  await setNativeCodeFeature(fixture, false);
  const liveExit = await pollNative(async () => {
    const observed = await manager.request('observe');
    return observed.workers.find(worker => worker.leaseId === liveLease)?.alive === false ? observed : null;
  }, 'actual live service owner to retire after current persisted feature disable');
  const liveReadOff = await ui.rpc('integrations/services/code/read', serviceRequest(ui.scope, { leaseId: liveLease }));
  const originalReceiptOff = await ui.rpc('integrations/services/code/start', liveRequest);
  assert.equal(originalReceiptOff.reconciled, true, 'The same completed control receipt remains readable with feature off');
  assert.equal(originalReceiptOff.ready, undefined, 'Reconciliation must not claim a new running task');
  const native = await ui.rpc('integrations/runtime/readTaskState', { requestId: 'disabled-original-task', scope: ui.scope,
    reference: { threadId: live.ready.acceptance.threadId, taskId: live.ready.acceptance.taskId } });
  const run = await ui.rpc('workflow/runs/read', { runId: live.ready.acceptance.taskId });
  assert.equal(run.status, 'cancelled', 'Use the original owned Workflow receipt, never infer cancellation from OS exit');
  assert.equal(native.state, 'cancelled');
  const revokedLiveOff = await ui.rpc('integrations/services/code/revoke', serviceRequest(ui.scope, { leaseId: liveLease },
    { operationId: `boundaries-live-off-revoke-${context.seed}`, expectedRevision: liveReadOff.record.revision }));
  assert.equal(revokedLiveOff.grant.status, 'revoked');
  const list = await ui.rpc('workflow/runs/list', { definitionId: source.definitionId, limit: 32 });
  assert.equal(list.total, 1, 'All denied and reconciled requests must not create another original task');
  await ui.close();
  const cleanup = await manager.close();
  await context.writeArtifactJson('native-code-live-disabled-original-receipt-proof.json', { actualOwner, live, liveExit,
    currentFeatureDisabled: true, liveReadOff, originalReceiptOff, native, run, revokedLiveOff, originalRunCount: list.total,
    sameOriginalStartRequest: true, noNewOperationForReconcile: true, cleanup, modelCalls: 0 });
  return { disabledBeforeMutation: true, forgedAuthorityDenied: true, liveDisabledOwnerExited: true,
    originalTaskCancelled: true, originalReadRevokeWithFeatureOff: true, originalRunCount: 1, modelCalls: 0 };
});
