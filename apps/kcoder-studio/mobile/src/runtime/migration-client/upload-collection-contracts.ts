import * as C from '../../../../shared/generated/contracts';
export interface UploadCollectionCalls {
  uploadCollectionAttachment: [C.MigrationUploadCollectionReadParams, C.MigrationUploadCollectionAttachmentResult];
  uploadCollectionPrepare: [C.MigrationUploadCollectionPrepareParams, C.MigrationUploadCollectionStateResult];
  uploadCollectionRead: [C.MigrationUploadCollectionReadParams, C.MigrationUploadCollectionStateResult];
  uploadCollectionList: [C.MigrationUploadCollectionListParams, C.MigrationUploadCollectionListResult];
  uploadCollectionRun: [C.MigrationUploadCollectionRunParams, C.MigrationUploadCollectionStateResult];
  uploadCollectionCancel: [C.MigrationUploadCollectionCancelParams, C.MigrationUploadCollectionStateResult];
  uploadCollectionResume: [C.MigrationUploadCollectionResumeParams, C.MigrationUploadCollectionStateResult];
}
const rule = (name: string, read: boolean, params: (v: unknown) => boolean, result: (v: unknown) => boolean, rows?: string[]) => ({ method: `migration/history/upload-collection/${name}`, caps: ['migrationUploadCollectionV1'], read, params, result, rows });
export const UPLOAD_COLLECTION_CALLS = {
  uploadCollectionAttachment: rule('attachment', true, C.isMigrationUploadCollectionReadParams, C.isMigrationUploadCollectionAttachmentResult),
  uploadCollectionPrepare: rule('prepare', false, C.isMigrationUploadCollectionPrepareParams, C.isMigrationUploadCollectionStateResult),
  uploadCollectionRead: rule('read', true, C.isMigrationUploadCollectionReadParams, C.isMigrationUploadCollectionStateResult),
  uploadCollectionList: rule('list', true, C.isMigrationUploadCollectionListParams, C.isMigrationUploadCollectionListResult, ['items']),
  uploadCollectionRun: rule('run', false, C.isMigrationUploadCollectionRunParams, C.isMigrationUploadCollectionStateResult),
  uploadCollectionCancel: rule('cancel', false, C.isMigrationUploadCollectionCancelParams, C.isMigrationUploadCollectionStateResult),
  uploadCollectionResume: rule('resume', false, C.isMigrationUploadCollectionResumeParams, C.isMigrationUploadCollectionStateResult),
};
