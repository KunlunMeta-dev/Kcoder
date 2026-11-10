import { expect, it } from 'vitest';
import { SOURCE_UPLOAD_CALLS, validSourceUploadResult } from './source-upload-contracts';
import { createMobileSourceUploadApi } from '../migration-source/upload-api';
import type { MobileMigrationClient } from '../migration-client';
const id = '10000000-0000-4000-8000-000000000001';
const state = { operationId: id, source: 'codex', manifestSha256: 'a'.repeat(64), stage: 'ready', sequence: 8, cancelWatermark: 0, cancelRequested: false, workerState: 'stopped', totalFiles: 1, completedFiles: 1, totalBytes: 3, receivedBytes: 3, verifiedBytes: 3 };
it('binds every response to its fixed upload/product and never treats partial Ready as complete', () => {
  expect(validSourceUploadResult('sourceUploadRead', { operationId: id }, { upload: state })).toBe(true);
  for (const patch of [{ operationId: 'peer' }, { verifiedBytes: 2 }, { completedFiles: 0 }, { cancelRequested: true }, { sequence: 0, cancelWatermark: 1 }, { totalBytes: 2 ** 32 }]) {
    expect(validSourceUploadResult('sourceUploadRead', { operationId: id }, { upload: { ...state, ...patch } })).toBe(false);
  }
  expect(validSourceUploadResult('sourceProductRead', { operationId: id, manifestSha256: 'b'.repeat(64) }, { materialization: state })).toBe(false);
  expect(SOURCE_UPLOAD_CALLS.sourceProductRead.caps).toEqual(['migrationSourceUploadedV1']);
  expect(SOURCE_UPLOAD_CALLS.sourceUploadPart.params({ operationId: id, fileIndex: 0, partIndex: 0, bytesBase64: '', sha256: 'a'.repeat(64), sourcePath: '/private' })).toBe(false);
});
it('exposes only the eleven typed methods and lets domain-owned cancellation bypass unrelated generic locator state', async () => {
  const calls: unknown[] = [];
  const client = { call: async (...args: unknown[]) => { calls.push(args); return { upload: state }; } } as unknown as MobileMigrationClient;
  const api = createMobileSourceUploadApi(client);
  await api.sourceUploadCancel({ operationId: id, commandId: id });
  expect(calls).toEqual([['sourceUploadCancel', { operationId: id, commandId: id }]]);
  expect(Object.keys(api)).toHaveLength(11);
  expect(Object.values(SOURCE_UPLOAD_CALLS).every(value => value.transient)).toBe(true);
});
