import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { nativeCodeFixture, pollNative, saveNativeCodeWorkflow, serviceRequest,
  startNativeCodeGateway, startNativeCodeManager, startNativeCodeUi } from '../../harness/native-code-service.mjs';
import { repoRoot, requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { verifyNativeCodeStorageRecovery } from '../../harness/native-code-storage-recovery.mjs';

const storageRecovery=process.env.KCODER_E2E_REL_STORAGE_RECOVERY==='1';

await runE2E(import.meta.url, {
  testId: storageRecovery?'native-saved-code-storage-backup-rollback-original-runtime-history':'native-saved-code-service-ui-detach-cold-receipt-and-exact-revoke', tier: 'full-integration',
  modelPolicy: 'Actual unprivileged Linux UID, kernel pidfds, independent manager and original Native saved Code/Runtime; no model, SDK or platform behavior claim',
  processSignalTimeoutMs: 15_000,
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'current Native Code service executable');
  if(storageRecovery)return verifyNativeCodeStorageRecovery(context,binary);
  const fixture = await nativeCodeFixture(context, binary);
  const ui = await startNativeCodeUi(context, fixture, 'native-code-original-ui');
  const sources = {
    revoked: await saveNativeCodeWorkflow(ui, 'OWNED_SERVICE_REVOKED', 120_000),
    peer: await saveNativeCodeWorkflow(ui, 'OWNED_SERVICE_PEER', 20_000),
  };
  const manager = await startNativeCodeManager(context, fixture, 'native-code-independent-manager');
  const services = {};
  for (const name of ['revoked', 'peer']) {
    const prepared = await ui.rpc('integrations/services/code/prepare', serviceRequest(ui.scope, {
      purpose: 'native_saved_code_service', explicitBackgroundConsent: true, expiresInMs: 300_000,
      codeWorkflow: sources[name],
    }, { operationId: `service-prepare-${name}-${context.seed}` }));
    assert.equal(prepared.enabled, false, 'Approval alone must not start a service');
    const started = await ui.rpc('integrations/services/code/start', serviceRequest(ui.scope, { leaseId: prepared.intent.leaseId },
      { operationId: `service-start-${name}-${context.seed}`, expectedRevision: prepared.revision }));
    assert.equal(started.ready?.modelCalls, 0);
    assert.ok(started.ready?.acceptance?.threadId && started.ready?.acceptance?.taskId);
    const owner = await manager.attach(prepared.intent.leaseId);
    assert.equal(owner.uid, fixture.uid);
    assert.equal(owner.imageSha256, fixture.imageSha256);
    services[name] = { prepared, started, owner };
  }
  await ui.close();
  const detached = await manager.request('observe');
  assert.ok(detached.managerAlive && detached.workers.length === 2 && detached.workers.every(worker => worker.alive),
    'Both actual services must survive the complete original supervised UI tree exiting');
  const reopened = await startNativeCodeGateway(context, fixture, 'native-code-observer-gateway');
  assert.deepEqual(reopened.scope, ui.scope, 'Cold UI observation must retain the exact native account/workspace/configuration scope');
  const reference = name => {
    const { threadId, taskId } = services[name].started.ready.acceptance;
    return { threadId, taskId };
  };
  const task = async name => reopened.rpc('integrations/runtime/readTaskState', {
    requestId: `service-task-${name}-${Date.now()}`, scope: reopened.scope, reference: reference(name),
  });
  const initialRevoked = await task('revoked');
  const initialPeer = await task('peer');
  assert.equal(initialRevoked.state, 'running');
  assert.equal(initialPeer.state, 'running', 'The peer must still be running when the other service is revoked');
  const current = await reopened.rpc('integrations/services/code/read', serviceRequest(reopened.scope,
    { leaseId: services.revoked.prepared.intent.leaseId }));
  const revoked = await reopened.rpc('integrations/services/code/revoke', serviceRequest(reopened.scope,
    { leaseId: current.record.intent.leaseId }, { operationId: `service-revoke-${context.seed}`, expectedRevision: current.record.revision }));
  assert.equal(revoked.record.state, 'revoked');
  assert.equal(revoked.grant.status, 'revoked');
  assert.equal(revoked.cancellationRequested, true);
  assert.equal(revoked.cancellationSettled, false, 'A request acknowledgement must not fabricate OS or business completion');
  const exactExit = await pollNative(async () => {
    const value = await manager.request('observe');
    const stopped = value.workers.find(worker => worker.leaseId === current.record.intent.leaseId);
    const peer = value.workers.find(worker => worker.leaseId === services.peer.prepared.intent.leaseId);
    assert.ok(peer?.alive, 'Revocation must preserve the actual peer worker');
    return stopped && !stopped.alive ? value : null;
  }, 'the revoked original worker pidfd to settle');
  const originalRun = services.peer.started.ready.acceptance.taskId;
  const completed = await pollNative(async () => {
    const snapshot = await task('peer');
    assert.ok(!['failed', 'cancelled', 'outcome_unknown'].includes(snapshot.state), `Actual peer task state: ${snapshot.state}`);
    return snapshot.state === 'completed' ? snapshot : null;
  }, 'the original peer Code task to complete', 40_000);
  const beforeCold = await reopened.rpc('workflow/runs/read', { runId: originalRun });
  assert.equal(beforeCold.status, 'completed');
  assert.match(beforeCold.nodeStates.find(node => node.nodeId === 'code')?.outputPreview || '', /OWNED_SERVICE_PEER/);
  const listedBefore = await reopened.rpc('workflow/runs/list', { definitionId: sources.peer.definitionId, limit: 32 });
  assert.equal(listedBefore.total, 1, 'The original source must have one accepted run');
  await reopened.close();
  const managerCrash = await manager.crash();
  const coldManager = await startNativeCodeManager(context, fixture, 'native-code-brand-new-manager');
  const originalOwnerCleanup = await managerCrash.completion;
  const coldOwner = await coldManager.attach(services.peer.prepared.intent.leaseId);
  assert.notEqual(coldOwner.pid, services.peer.owner.pid, 'Cold restoration must use a new actual OS owner');
  const coldUi = await startNativeCodeUi(context, fixture, 'native-code-cold-receipt-ui');
  const coldSnapshot = await coldUi.rpc('integrations/runtime/readTaskState', {
    requestId: 'native-service-cold-original-task', scope: coldUi.scope, reference: reference('peer'),
  });
  assert.equal(coldSnapshot.state, 'completed');
  assert.equal(coldSnapshot.operationId, completed.operationId);
  const afterCold = await coldUi.rpc('workflow/runs/read', { runId: originalRun });
  assert.deepEqual(afterCold, beforeCold, 'A new service owner must only read the exact original terminal receipt');
  const listedAfter = await coldUi.rpc('workflow/runs/list', { definitionId: sources.peer.definitionId, limit: 32 });
  assert.equal(listedAfter.total, 1, 'Cold restoration must not dispatch the workflow a second time');
  const noRevival = await coldUi.rpc('integrations/services/code/read', serviceRequest(coldUi.scope,
    { leaseId: services.revoked.prepared.intent.leaseId }));
  assert.equal(noRevival.record.enabled, false);
  assert.equal(noRevival.grant.status, 'revoked');
  const coldObserved = await coldManager.request('observe');
  assert.deepEqual(coldObserved.workers.map(worker => worker.leaseId), [services.peer.prepared.intent.leaseId]);
  await coldUi.close();
  const coldOwnerCleanup = await coldManager.close();
  const proof = { actualUid: fixture.uid, actualNativeImageSha256: fixture.imageSha256,
    explicitBackgroundConsent: true, source: 'saved_code_workflow', services, originalUiExited: true,
    detached, exactExit, completed, originalRun, beforeCold, afterCold, coldOwner, noNewDispatch: true,
    originalOwnerCleanup, coldOwnerCleanup, managerActuallyKilled: true, modelCalls: 0, sdkOrPlatformClaim: false, windowsClaim: false,
  };
  await context.writeArtifactJson('native-code-service-owner-lifetime-proof.json', proof);
  return { actualUid: fixture.uid, originalUiExited: true, coldOriginalReceipt: true, exactRevocation: true,
    peerPreserved: true, originalRuns: listedAfter.total, modelCalls: 0, sdkOrPlatformClaim: false };
});
