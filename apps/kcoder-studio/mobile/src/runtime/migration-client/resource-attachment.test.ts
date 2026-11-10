import { expect, it, vi } from 'vitest';
import { MobileMigrationClient } from '../migration-client';
import { RESOURCE_ATTACHMENT_CAPABILITY } from '../../../../shared/migrationResourceAttachment';
const limits = { maxTotalBytes: 4194304, maxPayloadFiles: 16, minFreeBytes: 1048576, minFreeFileNodes: 0 };
const view = { jobId: 'mig-owned', ownerJobId: 'mig-owned', currentSequence: 9, currentPlanId: 'plan-owned', phase: 'pending', originalIntent: { expectedSequence: 2, planId: 'plan-owned', initialLimits: limits }, issueCode: null };
it('observes attachment metadata without a generic mutation journal or fallback capability', async () => {
  const request = vi.fn().mockResolvedValue(view), journal = { read: vi.fn(async () => []), put: vi.fn(async () => {}) };
  const old = new MobileMigrationClient(request, { migrationHistoryResourceBudgetV1: true }, journal, () => true);
  await expect(old.call('batchResourceAttachmentRead', { jobId: view.jobId })).rejects.toMatchObject({ code: 'migration_update_required' }); expect(request).not.toHaveBeenCalled();
  const client = new MobileMigrationClient(request, { [RESOURCE_ATTACHMENT_CAPABILITY]: true }, journal, () => true);
  await expect(client.call('batchResourceAttachmentRead', { jobId: view.jobId })).resolves.toEqual(view);
  expect(journal.put).not.toHaveBeenCalled();
  request.mockResolvedValueOnce({ ...view, originalIntent: { ...view.originalIntent, planId: 'peer' } });
  await expect(client.call('batchResourceAttachmentRead', { jobId: view.jobId })).rejects.toMatchObject({ code: 'migration_invalid_response' });
});
