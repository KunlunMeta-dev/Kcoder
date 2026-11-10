import { expect, it, vi } from 'vitest';
import { MobileMigrationClient } from '../migration-client';
const locator = { jobId: 'original-job', itemId: 'original-agent' };
const value = { ...locator, compatibility: { sourceSha256: 'a'.repeat(64), canAdapt: true, availableTools: ['read'], sourceModelReference: true, problem: null } };
const store = { read: async () => [], put: async () => {} };
it('old targets refuse adaptation and preview before request or durable intent', async () => {
  const request = vi.fn(), client = new MobileMigrationClient(request, { migrationBatchV1: true, migrationAssetsV1: true }, store, () => true);
  await expect(client.call('agentPreview', locator)).rejects.toMatchObject({ code: 'migration_update_required' });
  await expect(client.call('plan', { jobId: locator.jobId, expectedSequence: 1, choices: [{ kind: 'asset', itemId: locator.itemId, targetName: 'review', agentAdaptation: { reviewedSourceSha256: 'a'.repeat(64), model: { kind: 'inherit' }, tools: ['read'] } }] })).rejects.toMatchObject({ code: 'migration_agent_update_required' });
  expect(request).not.toHaveBeenCalled();
});
it('validates original source compatibility and never writes an intent for inspection', async () => {
  const request = vi.fn(async () => value), put = vi.fn(), client = new MobileMigrationClient(request, { migrationAgentAdaptationV1: true }, { read: async () => [], put }, () => true);
  await expect(client.call('agentPreview', locator)).resolves.toEqual(value); expect(put).not.toHaveBeenCalled();
  request.mockResolvedValueOnce({ ...value, itemId: 'peer' }); await expect(client.call('agentPreview', locator)).rejects.toMatchObject({ code: 'migration_invalid_response' });
});
