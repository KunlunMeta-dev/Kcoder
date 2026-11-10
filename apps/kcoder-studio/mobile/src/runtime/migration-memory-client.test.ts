import { describe, expect, it, vi } from 'vitest';
import { MobileMigrationClient } from './migration-client';
import type { MigrationIntent, MigrationIntentStore } from '@/storage/migration-intents';
import type { MigrationMemoryControlParams } from '../../../shared/generated/contracts';
const requestId = '10000000-0000-4000-8000-000000000001';
const record = { id: 'notes-owned', ownerOperationId: 'mig-owned', name: 'notes', scope: { kind: 'global' }, enabled: false, revision: 'a'.repeat(64), bytes: 6, provenance: null };
const request: MigrationMemoryControlParams = { requestId, id: record.id, ownerOperationId: record.ownerOperationId, expectedRevision: record.revision, enabled: true, confirmUnverifiedNotes: true };
function journal(): MigrationIntentStore & { rows: MigrationIntent[] } {
  const store = { rows: [] as MigrationIntent[], async read() { return [...store.rows]; }, async put(row: MigrationIntent) { const i = store.rows.findIndex(value => value.id === row.id); if (i < 0) store.rows.push(row); else store.rows[i] = row; } }; return store;
}
const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(yes => { resolve = yes; }); return { promise, resolve }; };

describe('Mobile imported memory typed ownership and recovery', () => {
  it('persists the exact public CAS before sending, then reopens only by the original request receipt', async () => {
    const store = journal();
    const lost = vi.fn(async () => { expect(store.rows[0]).toMatchObject({ id: requestId, memoryControl: request, phase: 'intent' }); throw new Error('lost accepted reply'); });
    const first = new MobileMigrationClient(lost, { migrationMemoryV1: true }, store, () => true);
    await expect(first.call('memoryControl', request)).rejects.toMatchObject({ code: 'migration_request_failed' });
    expect(store.rows).toHaveLength(1); expect(store.rows[0].phase).toBe('unknown'); first.close();
    const response = { receipt: { request: { ...request }, appliedRevision: 'b'.repeat(64) }, current: { ...record, enabled: false, revision: 'c'.repeat(64) } };
    const transport = vi.fn(async () => response), reopened = new MobileMigrationClient(transport, { migrationMemoryV1: true }, store, () => true);
    expect(transport).not.toHaveBeenCalled();
    const observed = await reopened.call('memoryControlRead', { requestId });
    expect(observed.receipt?.request.enabled).toBe(true); expect(observed.current?.enabled).toBe(false);
    expect(transport.mock.calls).toHaveLength(1); expect(store.rows[0].phase).toBe('unknown');
    await expect(reopened.call('memoryControl', { ...request, expectedRevision: 'd'.repeat(64) })).rejects.toMatchObject({ code: 'migration_recovery_identity_changed' });
    expect(transport.mock.calls).toHaveLength(1);
    await reopened.call('memoryControl', request); expect(store.rows).toHaveLength(1); expect(store.rows[0].phase).toBe('acknowledged');
  });
  it('refuses unconfirmed enabling, another owner receipt, oversized UTF8 windows, stalled pages and a foreign catalog', async () => {
    const transport = vi.fn(async () => null), client = new MobileMigrationClient(transport, { migrationMemoryV1: true }, journal(), () => true);
    await expect(client.call('memoryControl', { ...request, confirmUnverifiedNotes: false })).rejects.toMatchObject({ code: 'migration_memory_confirmation_required' });
    expect(transport).not.toHaveBeenCalled();
    for (const [name, params, value] of [
      ['memoryControl', request, { receipt: { request: { ...request, ownerOperationId: 'peer' }, appliedRevision: 'b' }, current: null }],
      ['memoryRead', { id: record.id }, { record, text: '中'.repeat(3000), totalBytes: 9000, nextOffset: null }],
      ['memoryList', { pageIndex: 1 }, { items: [], totalRecords: 0, nextPage: 1 }],
      ['memorySources', { catalogId: 'original' }, { catalogId: 'peer', items: [], nextCursor: null, problems: [], unobserved: [] }],
    ] as const) {
      const c = new MobileMigrationClient(async () => value, { migrationMemoryV1: true }, journal(), () => true);
      await expect(c.call(name, params as never)).rejects.toMatchObject({ code: 'migration_invalid_response' });
    }
  });
  it('storage failure prevents dispatch, and late completion cannot cross account or target ownership', async () => {
    const store = journal(), transport = vi.fn(); store.put = async () => { throw new Error('storage unavailable'); };
    const c = new MobileMigrationClient(transport, { migrationMemoryV1: true }, store, () => true);
    await expect(c.call('memoryControl', request)).rejects.toBeDefined(); expect(transport).not.toHaveBeenCalled();
    const later = deferred(); let current = true;
    const d = new MobileMigrationClient(() => later.promise, { migrationMemoryV1: true }, journal(), () => current);
    const read = d.call('memoryRead', { id: record.id }); current = false;
    later.resolve({ record, text: '笔记', totalBytes: 6, nextOffset: null });
    await expect(read).rejects.toMatchObject({ code: 'migration_scope_changed' });
  });
  it('requires the independent capability and inactive import choice; a mapping grants no workspace', async () => {
    const transport = vi.fn(), old = new MobileMigrationClient(transport, { migrationBatchV1: true, migrationAssetsV1: true }, journal(), () => true);
    const plan = { jobId: 'mig-owned', expectedSequence: 1, choices: [{ kind: 'asset' as const, itemId: 'memory', targetName: 'notes', memoryMapping: 'global' as const, enableAfterImport: false }], includeDefaultItems: false, excludedItemIds: [], reuseExisting: false };
    await expect(old.call('plan', plan)).rejects.toMatchObject({ code: 'migration_memory_confirmation_required' });
    expect(old.workspaceAvailable()).toBe(false);
    const current = new MobileMigrationClient(transport, { migrationBatchV1: true, migrationAssetsV1: true, migrationMemoryV1: true }, journal(), () => true, '/owned/workspace');
    await expect(current.call('plan', { ...plan, choices: [{ ...plan.choices[0], enableAfterImport: true }] })).rejects.toMatchObject({ code: 'migration_memory_confirmation_required' });
    expect(transport).not.toHaveBeenCalled(); expect(current.workspaceAvailable()).toBe(true);
  });
});
