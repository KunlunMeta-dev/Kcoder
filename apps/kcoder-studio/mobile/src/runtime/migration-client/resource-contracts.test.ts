import { expect, it, vi } from 'vitest';
import { MobileMigrationClient } from '../migration-client';
const limits = { maxTotalBytes: 1024, maxPayloadFiles: 1, minFreeBytes: 1048576, minFreeFileNodes: 0 };
const view = { phase: 'active', jobId: 'mig-owned', limits, policyRevision: 0, usage: { reservedBytes: 0, committedBytes: 0, reservedFiles: 0, committedFiles: 0 } };
const intent = { jobId: 'mig-owned', planId: 'plan-owned', requestId: 'request-owned', expectedPolicyRevision: 0, confirm: true, limits: { ...limits, maxPayloadFiles: 2 } };
const journal = () => ({ read: vi.fn(async () => []), put: vi.fn(async () => {}) });
it('checks budget capability and full typed intent before transport, preserving old scans without the optional field', async () => {
  const request = vi.fn(), store = journal(), old = new MobileMigrationClient(request, { migrationBatchV1: true }, store, () => true);
  await expect(old.call('resourcesRead', { jobId: intent.jobId })).rejects.toMatchObject({ code: 'migration_update_required' });
  await expect(old.call('scan', { sourceIds: [], resourceLimits: limits })).rejects.toMatchObject({ code: 'migration_resource_budget_update_required' });
  const client = new MobileMigrationClient(request, { migrationResourceBudgetV1: true }, store, () => true);
  await expect(client.call('resourcesIncrease', { ...intent, confirm: false })).rejects.toMatchObject({ code: 'migration_invalid_parameters' });
  await expect(client.call('resourcesIncrease', { ...intent, limits: { maxPayloadFiles: 2 } })).rejects.toMatchObject({ code: 'migration_invalid_parameters' });
  expect(request).not.toHaveBeenCalled(); expect(store.put).not.toHaveBeenCalled();
});
it('reads only bound facts and original receipts; the budget coordinator owns increase recovery, not a second journal', async () => {
  const request = vi.fn().mockResolvedValueOnce({ ...view, usage: { reservedBytes: 0, committedBytes: 512, reservedFiles: 0, committedFiles: 1 } }).mockResolvedValueOnce({ jobId: intent.jobId, requestId: intent.requestId, previousRevision: 0, revision: 1, limits: intent.limits });
  const store = journal(), client = new MobileMigrationClient(request, { migrationResourceBudgetV1: true }, store, () => true);
  await expect(client.call('resourcesRead', { jobId: intent.jobId })).resolves.toHaveProperty('phase', 'active');
  await expect(client.call('resourcesIncrease', intent)).resolves.toHaveProperty('revision', 1);
  expect(store.put).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(2);
  for (const result of [{ ...view, jobId: 'peer' }, { ...view, limits: { maxTotalBytes: 1 } }, { ...view, requestedReceipt: { jobId: 'peer', requestId: intent.requestId, previousRevision: 0, revision: 1, limits } }]) {
    request.mockResolvedValueOnce(result); await expect(client.call('resourcesRead', { jobId: intent.jobId, requestId: intent.requestId })).rejects.toMatchObject({ code: 'migration_invalid_response' });
  }
});
it('allows only explicit resume of an incomplete terminal batch and uses its newly read sequence', async () => {
  const batch = (status: string, unresolvedActions: number) => ({ state: { source: 'codex', job: { jobId: intent.jobId, sourceId: 'source', status, sequence: 8, totalItems: 1, committedItems: 0, requiresActionItems: 0 }, plans: [], issues: [], batch: { planId: intent.planId, selectedItems: 1, totalActions: 1, committedActions: 0, unresolvedActions } }, workerRunning: false, workerError: null, progress: null });
  const request = vi.fn().mockResolvedValueOnce(batch('completed_with_issues', 1)).mockResolvedValueOnce(batch('completed', 0));
  const client = new MobileMigrationClient(request, { migrationBatchV1: true, migrationBatchWorkersV1: true }, journal(), () => true);
  await client.operateBatch(intent.jobId, intent.planId, 'resume', 'explicit-resume');
  expect(request).toHaveBeenLastCalledWith('migration/batch/run', { jobId: intent.jobId, planId: intent.planId, requestId: 'explicit-resume', mode: 'resume', expectedSequence: 8 });
  for (const [status, unresolved] of [['completed', 1], ['completed_with_issues', 0], ['rolled_back', 1]] as const) {
    request.mockResolvedValueOnce(batch(status, unresolved)); const before = request.mock.calls.length;
    await client.operateBatch(intent.jobId, intent.planId, 'resume', 'explicit-other'); expect(request).toHaveBeenCalledTimes(before + 1);
  }
});
it('invalidates a late budget response after an account/target switch instead of storing peer facts', async () => {
  let finish!: (value: unknown) => void, current = true;
  const request = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const client = new MobileMigrationClient(request, { migrationResourceBudgetV1: true }, journal(), () => current);
  const observing = client.call('resourcesRead', { jobId: intent.jobId }); current = false; finish(view);
  await expect(observing).rejects.toMatchObject({ code: 'migration_scope_changed' }); expect(request).toHaveBeenCalledTimes(1);
});
it('uses independent history authority and rejects wrong owner facts without falling back to batch authority', async () => {
  const id = '4c6d9ee9-d145-4da4-ac73-35c2dce251ea';
  const request = vi.fn(), store = journal();
  const old = new MobileMigrationClient(request, { migrationResourceBudgetV1: true, migrationHistoryJobsV1: true }, store, () => true);
  await expect(old.call('historyResourcesRead', { jobId: id })).rejects.toMatchObject({ code: 'migration_update_required' });
  await expect(old.call('historyCreate', { catalogId: 'catalog', sourceHandle: 'source', requestId: id, resourceLimits: limits })).rejects.toMatchObject({ code: 'migration_update_required' });
  expect(request).not.toHaveBeenCalled();
  const client = new MobileMigrationClient(request, { migrationHistoryResourceBudgetV1: true }, store, () => true);
  const result = { ownerJobId: id, initialLimits: limits, budget: { ...view, jobId: id } };
  request.mockResolvedValueOnce(result);
  await expect(client.call('historyResourcesRead', { jobId: id })).resolves.toEqual(result);
  request.mockResolvedValueOnce({ ...result, ownerJobId: null });
  await expect(client.call('historyResourcesRead', { jobId: id })).rejects.toMatchObject({ code: 'migration_invalid_response' });
  expect(store.put).not.toHaveBeenCalled();
});
it('records the fixed standalone creation identity before dispatch and recovers a lost receipt only by that job', async () => {
  const id = '4c6d9ee9-d145-4da4-ac73-35c2dce251ea';
  const store = journal(), request = vi.fn(async () => { expect(store.put).toHaveBeenCalledWith(expect.objectContaining({ jobId: id, requestId: id, method: 'migration/history/create', phase: 'intent' })); throw Error('lost acknowledgement'); });
  const client = new MobileMigrationClient(request, { migrationHistoryResourceBudgetV1: true }, store, () => true);
  await expect(client.call('historyCreate', { catalogId: 'catalog', sourceHandle: 'opaque', requestId: id, resourceLimits: limits })).rejects.toMatchObject({ code: 'migration_request_failed' });
  expect(request).toHaveBeenCalledTimes(1);
  expect(store.put).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: id, requestId: id, phase: 'unknown' }));
});
