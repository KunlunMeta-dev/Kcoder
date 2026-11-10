import { expect, it, vi } from 'vitest';
import { MobileMigrationClient } from './migration-client';
import type { MigrationIntentStore } from '@/storage/migration-intents';

const result = { jobId: 'owned', status: 'selection_required', names: ['docs'], totalNames: 1, revision: 'a'.repeat(64), nextPageIndex: null };
const journal: MigrationIntentStore = { read: async () => [], put: async () => {} };

it('requires the explicit capability and rejects invalid catalog binding before accepting it', async () => {
  const request = vi.fn().mockResolvedValue(result);
  const old = new MobileMigrationClient(request, {}, journal, () => true);
  await expect(old.call('projectMcpCatalog', { jobId: 'owned' })).rejects.toMatchObject({ code: 'migration_update_required' });
  expect(request).not.toHaveBeenCalled();
  const client = new MobileMigrationClient(request, { migrationProjectMcpInheritanceV1: true }, journal, () => true);
  await expect(client.call('projectMcpCatalog', { jobId: 'owned', pageIndex: 1 })).rejects.toMatchObject({ code: 'migration_invalid_parameters' });
  expect(request).not.toHaveBeenCalled();
  await expect(client.call('projectMcpCatalog', { jobId: 'owned' })).resolves.toEqual(result);
  request.mockResolvedValueOnce({ ...result, jobId: 'peer' });
  await expect(client.call('projectMcpCatalog', { jobId: 'owned' })).rejects.toMatchObject({ code: 'migration_invalid_response' });
});

it('does not send an inherited selection to an older target or silently omit that choice', async () => {
  const request = vi.fn();
  const client = new MobileMigrationClient(request, { migrationBatchV1: true }, journal, () => true);
  await expect(client.call('plan', { jobId: 'owned', expectedSequence: 1, choices: [], projectMcpInheritance: { names: [], expectedRevision: 'a'.repeat(64) } }))
    .rejects.toMatchObject({ code: 'migration_project_mcp_update_required' });
  expect(request).not.toHaveBeenCalled();
});

it('discards a catalog response after account ownership is lost without creating mutation intents', async () => {
  let current = true, release!: (value: unknown) => void;
  const request = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const saved = { read: vi.fn(async () => []), put: vi.fn(async () => {}) };
  const client = new MobileMigrationClient(request, { migrationProjectMcpInheritanceV1: true }, saved, () => current);
  const pending = client.call('projectMcpCatalog', { jobId: 'owned' });
  current = false; release(result);
  await expect(pending).rejects.toMatchObject({ code: 'migration_scope_changed' });
  expect(saved.put).not.toHaveBeenCalled();
});
