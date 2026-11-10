import { expect, it, vi } from 'vitest';
import { MobileMigrationClient } from '../migration-client';
import { HISTORY_FAMILIES_METHOD } from '../../../../shared/migrationHistoryFamilies';
const page = { catalogId: 'owned', discoveryComplete: true, items: [], problems: [], totalItems: 0, nextCursor: null };
const journal = { read: async () => [], put: vi.fn() };
it('requires the dedicated capability and explicit Codex input before any Native request or journal mutation', async () => {
  const rpc = vi.fn(async () => page), old = new MobileMigrationClient(rpc, { migrationHistoryJobsV1: true }, journal, () => true);
  await expect(old.call('historyFamilies', { source: 'codex' })).rejects.toMatchObject({ code: 'migration_update_required' }); expect(rpc).not.toHaveBeenCalled();
  const client = new MobileMigrationClient(rpc, { migrationHistoryFamilyIndexV1: true }, journal, () => true);
  await expect(client.call('historyFamilies', { source: 'claude-code' })).rejects.toBeDefined(); expect(rpc).not.toHaveBeenCalled();
  await expect(client.call('historyFamilies', { source: 'codex' })).resolves.toEqual(page);
  expect(rpc).toHaveBeenCalledWith(HISTORY_FAMILIES_METHOD, { source: 'codex' }); expect(journal.put).not.toHaveBeenCalled();
});
it('rejects malformed row/cursor facts and discards a late result after the account/target scope changes', async () => {
  let finish!: (value: unknown) => void, current = true;
  const rpc = vi.fn(() => new Promise<unknown>(resolve => { finish = resolve; }));
  const client = new MobileMigrationClient(rpc, { migrationHistoryFamilyIndexV1: true }, journal, () => current);
  const pending = client.call('historyFamilies', { source: 'codex' }); await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce()); current = false; finish(page);
  await expect(pending).rejects.toMatchObject({ code: 'migration_scope_changed' }); expect(journal.put).not.toHaveBeenCalled();
  const malformed = new MobileMigrationClient(vi.fn(async () => ({ ...page, totalItems: 12 })), { migrationHistoryFamilyIndexV1: true }, journal, () => true);
  await expect(malformed.call('historyFamilies', { source: 'codex' })).rejects.toMatchObject({ code: 'migration_invalid_response' });
});
