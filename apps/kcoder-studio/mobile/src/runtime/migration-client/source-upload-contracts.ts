import * as C from '../../../../shared/generated/contracts';
export interface SourceUploadCalls {
  sourceUploadPrepare: [C.MigrationSourceUploadPrepareParams, C.MigrationSourceUploadStateResult];
  sourceUploadRead: [C.MigrationSourceUploadReadParams, C.MigrationSourceUploadStateResult];
  sourceUploadFiles: [C.MigrationSourceUploadFilesParams, C.MigrationSourceUploadFilesResult];
  sourceUploadPart: [C.MigrationSourceUploadPartParams, C.MigrationSourceUploadStateResult];
  sourceUploadFinish: [C.MigrationSourceUploadRunParams, C.MigrationSourceUploadStateResult];
  sourceUploadResume: [C.MigrationSourceUploadRunParams, C.MigrationSourceUploadStateResult];
  sourceUploadCancel: [C.MigrationSourceUploadCancelParams, C.MigrationSourceUploadStateResult];
  sourceProductRead: [C.MigrationSourceProductParams, C.MigrationSourceProductStateResult];
  sourceProductRun: [C.MigrationSourceProductRunParams, C.MigrationSourceProductStateResult];
  sourceProductResume: [C.MigrationSourceProductRunParams, C.MigrationSourceProductStateResult];
  sourceProductCancel: [C.MigrationSourceProductCancelParams, C.MigrationSourceProductStateResult];
}
// These domain controllers persist their canonical upload/control selectors before
// calling this API. Duplicating them in the generic 64-locator journal would block
// cancellation behind unrelated unresolved migrations and add a write per chunk.
const rule = (method: string, cap: string, read: boolean, params: (v: unknown) => boolean, result: (v: unknown) => boolean, transient = true) => ({ method: `migration/source/upload/${method}`, caps: [cap], read, params, result, transient });
const upload = 'migrationSourceUploadV1', product = 'migrationSourceUploadedV1';
export const SOURCE_UPLOAD_CALLS = {
  sourceUploadPrepare: rule('prepare', upload, false, C.isMigrationSourceUploadPrepareParams, C.isMigrationSourceUploadStateResult),
  sourceUploadRead: rule('read', upload, true, C.isMigrationSourceUploadReadParams, C.isMigrationSourceUploadStateResult),
  sourceUploadFiles: rule('files', upload, true, C.isMigrationSourceUploadFilesParams, C.isMigrationSourceUploadFilesResult),
  // The immutable Native part receipt belongs to its already persisted upload operation.
  sourceUploadPart: rule('part', upload, false, C.isMigrationSourceUploadPartParams, C.isMigrationSourceUploadStateResult, true),
  sourceUploadFinish: rule('finish', upload, false, C.isMigrationSourceUploadRunParams, C.isMigrationSourceUploadStateResult),
  sourceUploadResume: rule('resume', upload, false, C.isMigrationSourceUploadRunParams, C.isMigrationSourceUploadStateResult),
  sourceUploadCancel: rule('cancel', upload, false, C.isMigrationSourceUploadCancelParams, C.isMigrationSourceUploadStateResult),
  sourceProductRead: rule('product/read', product, true, C.isMigrationSourceProductParams, C.isMigrationSourceProductStateResult),
  sourceProductRun: rule('product/run', product, false, C.isMigrationSourceProductRunParams, C.isMigrationSourceProductStateResult),
  sourceProductResume: rule('product/resume', product, false, C.isMigrationSourceProductRunParams, C.isMigrationSourceProductStateResult),
  sourceProductCancel: rule('product/cancel', product, false, C.isMigrationSourceProductCancelParams, C.isMigrationSourceProductStateResult),
};
export function validSourceUploadResult(name: string, input: unknown, value: unknown): boolean {
  if (!(name in SOURCE_UPLOAD_CALLS)) return true;
  const p = input as Record<string, any>, r = value as Record<string, any>;
  if (name === 'sourceUploadFiles') return r.page.operationId === p.operationId && r.page.files.length <= 10 && (r.page.nextCursor == null || r.page.nextCursor > (p.cursor ?? 0));
  const state: C.SourceUploadState = name.startsWith('sourceProduct') ? r.materialization : r.upload;
  return state.operationId === p.operationId && (!p.manifestSha256 || state.manifestSha256 === p.manifestSha256)
    && [state.sequence, state.cancelWatermark, state.totalBytes, state.receivedBytes, state.verifiedBytes].every(Number.isSafeInteger)
    && state.totalBytes <= 2 * 1024 ** 3 && state.receivedBytes <= state.totalBytes && state.verifiedBytes <= state.totalBytes
    && state.totalFiles >= 1 && state.totalFiles <= 1024 && state.completedFiles <= state.totalFiles && state.cancelWatermark <= state.sequence
    && (!name.startsWith('sourceProduct') || state.receivedBytes === state.totalBytes)
    && (state.stage !== 'ready' || state.verifiedBytes === state.totalBytes && state.completedFiles === state.totalFiles && !state.cancelRequested);
}
