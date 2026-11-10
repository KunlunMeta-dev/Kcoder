import { beforeEach, expect, it, vi } from 'vitest';
import { MobileMigrationClient } from './migration-client';
import { recoverHistoricalLocator } from './migration-history-recovery';
import type { MigrationIntent, MigrationIntentStore } from '@/storage/migration-intents';
const selection = { jobId: 'history', position: 0, blockIndex: 1 };
const collection = { operationId: 'owned', selection, collectionId: 'a'.repeat(64), sequence: 2, uploadSequence: 5, stage: 'prepared', cancelRequested: false, cancelRevision: 0, storageRetired: false, deletedBytes: 0, releasedReservationBytes: 0, failureCode: null };
const state = { collection, workerRunning: false, workerScheduled: false, workerError: null };
function journal() { const rows: MigrationIntent[] = []; const store: MigrationIntentStore = { async read() { return [...rows]; }, async put(row) { const index = rows.findIndex(v => v.id === row.id); if (index >= 0) rows[index] = row; else rows.push(row); } }; return { store, rows }; }
const params = { operationId: 'owned', selection, collectionId: collection.collectionId, expectedSequence: 2 };
beforeEach(() => vi.clearAllMocks());
it('requires the independent capability and rejects path authority before dispatch', async () => {
  const request = vi.fn(); const old = new MobileMigrationClient(request, {}, journal().store, () => true);
  await expect(old.call('uploadCollectionRead', { operationId: 'owned', selection })).rejects.toMatchObject({ code: 'migration_update_required' });
  const client = new MobileMigrationClient(request, { migrationUploadCollectionV1: true }, journal().store, () => true);
  await expect(client.call('uploadCollectionRun', { ...params, sourcePath: 'NEVER_AUTHORIZED' } as never)).rejects.toMatchObject({ code: 'migration_invalid_parameters' });
  expect(request).not.toHaveBeenCalled();
});
it('mount-style list/read perform no mutation and reject oversized or cross-selection receipts', async () => {
  const saved = journal(), request = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const client = new MobileMigrationClient(request, { migrationUploadCollectionV1: true }, saved.store, () => true);
  await client.call('uploadCollectionList', { selection }); expect(saved.rows).toEqual([]);
  request.mockResolvedValue({ ...state, collection: { ...collection, selection: { ...selection, position: 99 } } });
  await expect(client.call('uploadCollectionRead', { operationId: 'owned', selection })).rejects.toMatchObject({ code: 'migration_invalid_response' });
  request.mockResolvedValue({ items: Array(11).fill(state), nextCursor: null });
  await expect(client.call('uploadCollectionList', { selection })).rejects.toMatchObject({ code: 'migration_invalid_response' });
  expect(saved.rows).toEqual([]);
});
it('lost deletion acknowledgement keeps the original locator and only an explicit read reconciles it', async () => {
  const saved = journal(), request = vi.fn(async (method: string) => { if (method.endsWith('/run')) { expect(saved.rows[0]).toMatchObject({ operationId: 'owned', selection, phase: 'intent' }); throw new Error('connection dropped'); } return { ...state, collection: { ...collection, stage: 'collected', storageRetired: true, deletedBytes: 10, releasedReservationBytes: 20 } }; });
  const client = new MobileMigrationClient(request, { migrationUploadCollectionV1: true }, saved.store, () => true);
  await expect(client.call('uploadCollectionRun', params)).rejects.toMatchObject({ code: 'migration_request_failed' });
  expect(saved.rows[0]).toMatchObject({ operationId: 'owned', phase: 'unknown' }); expect(request).toHaveBeenCalledOnce();
  await client.call('uploadCollectionRead', { operationId: 'owned', selection });
  expect(request.mock.calls.map(v => v[0])).toEqual(['migration/history/upload-collection/run','migration/history/upload-collection/read']);
});
it('an account change during intent persistence prevents submission of a deletion', async () => {
  let current = true, release!: () => void; const waiting = new Promise<void>(done => { release = done; });
  const saved = journal(), put = saved.store.put; saved.store.put = async row => { await put(row); await waiting; };
  const request = vi.fn(), client = new MobileMigrationClient(request, { migrationUploadCollectionV1: true }, saved.store, () => current);
  const operation = client.call('uploadCollectionRun', params); await Promise.resolve(); current = false; release();
  await expect(operation).rejects.toMatchObject({ code: 'migration_scope_changed' }); expect(request).not.toHaveBeenCalled();
});
it('a persisted collection locator reopens its own Native record without replaying removal', async () => {
  const request = vi.fn().mockResolvedValue(state), client = new MobileMigrationClient(request, { migrationUploadCollectionV1: true }, journal().store, () => true);
  expect(await recoverHistoricalLocator(client, { id: 'intent', operationId: 'owned', selection, method: 'migration/history/upload-collection/run', phase: 'unknown', createdAt: 0 })).toEqual({ sourceJobId: 'history' });
  expect(request.mock.calls.map(v => v[0])).toEqual(['migration/history/upload-collection/read']);
});

it('a completed collection exposes only the same ready final Local receipt through a read-only lookup', async () => {
  const job = { selection, state: { operationId: 'owned', sequence: 7, stage: 'ready', processedBytes: 3, receipt: { attachmentId: 'final', bytes: 3, sha256: 'a'.repeat(64), chunkBytes: 262144 }, failureCode: null, cancelRequested: false, cancelRevision: 0 }, info: { kind: 'local_reference', mediaType: null, displayName: 'final.txt', receipt: null, issue: null }, historicalContentVerified: false };
  const request = vi.fn().mockResolvedValue({ job }), saved = journal();
  const client = new MobileMigrationClient(request, { migrationUploadCollectionV1: true }, saved.store, () => true);
  expect((await client.call('uploadCollectionAttachment', { operationId: 'owned', selection })).job).toEqual(job);
  expect(saved.rows).toEqual([]);
  request.mockResolvedValue({ job: { ...job, historicalContentVerified: true } });
  await expect(client.call('uploadCollectionAttachment', { operationId: 'owned', selection })).rejects.toMatchObject({ code: 'migration_invalid_response' });
  expect(request.mock.calls.every(row => row[0] === 'migration/history/upload-collection/attachment')).toBe(true);
});
