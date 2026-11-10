import type {
  MigrationUploadCollectionPrepareParams,
  MigrationUploadCollectionReadParams,
  MigrationUploadCollectionListParams,
  MigrationUploadCollectionRunParams,
  MigrationUploadCollectionCancelParams,
  MigrationUploadCollectionResumeParams,
  MigrationUploadCollectionStateResult,
  MigrationUploadCollectionListResult,
  MigrationUploadCollectionAttachmentResult,
} from '../../../shared/generated/contracts'
import {
  isMigrationUploadCollectionStateResult,
  isMigrationUploadCollectionListResult,
  isMigrationUploadCollectionAttachmentResult,
} from '../../../shared/generated/contracts'
import { validUploadCollectionResult } from '../../../shared/migrationUploadCollection'

type Invoke = <T>(method: string, params: object, options?: { signal?: AbortSignal }) => Promise<T>
export const UPLOAD_COLLECTION_METHODS = [
  'prepare',
  'read',
  'list',
  'run',
  'cancel',
  'resume',
  'attachment',
].map(name => `migration/history/upload-collection/${name}`)
export function createUploadCollectionApi(invoke: Invoke) {
  async function state(name: string, params: object, options?: { signal?: AbortSignal }) {
    const result = await invoke<MigrationUploadCollectionStateResult>(
      `migration/history/upload-collection/${name}`,
      params,
      options
    )
    if (
      !isMigrationUploadCollectionStateResult(result) ||
      !validUploadCollectionResult(params, result)
    )
      throw new Error('local_upload_collection_invalid_response')
    return result
  }
  return {
    uploadCollectionAttachment: async (
      params: MigrationUploadCollectionReadParams,
      options?: { signal?: AbortSignal }
    ) => {
      const result = await invoke<MigrationUploadCollectionAttachmentResult>(
        'migration/history/upload-collection/attachment',
        params,
        options
      )
      if (
        !isMigrationUploadCollectionAttachmentResult(result) ||
        !validUploadCollectionResult(params, result)
      )
        throw new Error('local_upload_collection_invalid_response')
      return result
    },
    uploadCollectionPrepare: (params: MigrationUploadCollectionPrepareParams) =>
      state('prepare', params),
    uploadCollectionRead: (
      params: MigrationUploadCollectionReadParams,
      options?: { signal?: AbortSignal }
    ) => state('read', params, options),
    uploadCollectionRun: (params: MigrationUploadCollectionRunParams) => state('run', params),
    uploadCollectionCancel: (params: MigrationUploadCollectionCancelParams) =>
      state('cancel', params),
    uploadCollectionResume: (params: MigrationUploadCollectionResumeParams) =>
      state('resume', params),
    uploadCollectionList: async (
      params: MigrationUploadCollectionListParams,
      options?: { signal?: AbortSignal }
    ) => {
      const result = await invoke<MigrationUploadCollectionListResult>(
        'migration/history/upload-collection/list',
        params,
        options
      )
      if (
        !isMigrationUploadCollectionListResult(result) ||
        !validUploadCollectionResult(params, result)
      )
        throw new Error('local_upload_collection_invalid_response')
      return result
    },
  }
}
