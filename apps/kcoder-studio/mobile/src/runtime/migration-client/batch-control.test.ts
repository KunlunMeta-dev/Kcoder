import { expect, test, vi } from 'vitest';
import { MobileMigrationClient } from '../migration-client';
import { BATCH_CONTROL_CAPABILITY, BATCH_CONTROL_METHODS } from '../../../../shared/migrationBatchControl';
import type { MigrationBatchControlCancelParams } from '../../../../shared/generated/contracts';

const caps = { migrationBatchV1: true, migrationBatchWorkersV1: true, migrationProvidersV1: true, [BATCH_CONTROL_CAPABILITY]: true };
const journal = { read: async () => [], put: vi.fn(async () => {}) };
const active = (sequence = 14, cancel = false) => ({ state: { job: { jobId: 'job', sourceId: 'source', status: cancel ? 'cancel_requested' : 'applying', sequence,
  totalItems: 128, committedItems: 12, requiresActionItems: 0 }, source: 'claude-code', plans: [], issues: [],
  batch: { planId: 'plan', selectedItems: 128, totalActions: 128, committedActions: 12, unresolvedActions: 0 } }, workerRunning: true, workerError: null, progress: null });
const observation = () => ({ jobId: 'job', currentSequence: 14, planId: 'plan', phase: 'tracked', generation: { planId: 'plan', runRequestId: 'original-run', admissionSequence: 3, mode: 'apply' }, cancelRequested: false, lastCancellation: null, requestedReceipt: null });

test('Mobile cancels the original execution despite moving progress and keeps observing the live worker', async () => {
  let requested = false;
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'migration/batch/read') return active(requested ? 30 : 14, requested);
    if (method === BATCH_CONTROL_METHODS.read) return observation();
    expect(method).toBe(BATCH_CONTROL_METHODS.cancel);
    expect(params).toMatchObject({ jobId: 'job', planId: 'plan', runRequestId: 'original-run', admissionSequence: 3 });
    expect(params).not.toHaveProperty('expectedSequence');
    requested = true;
    const { jobId: _, ...receipt } = params as MigrationBatchControlCancelParams;
    return { ...observation(), currentSequence: 28, cancelRequested: true, lastCancellation: { ...receipt, acceptedSequence: 25 }, requestedReceipt: { ...receipt, acceptedSequence: 25 } };
  });
  const client = new MobileMigrationClient(request, caps, journal, () => true);
  const result = await client.operateBatch('job', 'plan', 'cancel', 'ignored-run-id');
  expect(result.workerRunning).toBe(true);
  expect(result.state.job.status).toBe('cancel_requested');
  expect(request.mock.calls.map(row => row[0])).toEqual(['migration/batch/read', BATCH_CONTROL_METHODS.read, BATCH_CONTROL_METHODS.cancel, 'migration/batch/read']);
  expect(journal.put).not.toHaveBeenCalled();
});

test('Mobile refuses new controls on older targets and does not send an unknown generation', async () => {
  const request = vi.fn(async () => observation());
  const older = new MobileMigrationClient(request, { ...caps, [BATCH_CONTROL_CAPABILITY]: false }, journal, () => true);
  await expect(older.call('batchControlRead', { jobId: 'job' })).rejects.toMatchObject({ code: 'migration_update_required' });
  expect(request).not.toHaveBeenCalled();
  const unknown = new MobileMigrationClient(async method => method === 'migration/batch/read' ? active() : { ...observation(), phase: 'legacy_unknown', generation: null }, caps, journal, () => true);
  await expect(unknown.operateBatch('job', 'plan', 'cancel', 'ignored')).rejects.toThrow('migration_batch_control_unknown');
});
