import { requestLocalExecutor } from '@/tauri/localExecutor'
import i18n from '@/i18n'
import { captureAccountContextRevision } from './accountContextEvents'
import type { WorkspaceFileApi, WorkspaceUploadResult } from '@/types/workspace-files'
import { resolveWorkspaceFilePath } from '@/lib/workspace-file-path'
import { workspacePathKey } from '@/lib/workspace-path-identity'

const CHUNK = 192 * 1024
const LIMIT = 100 * 1024 * 1024

function receipt(result: WorkspaceUploadResult, parentPath: string, file: File) {
  const expectedPath = resolveWorkspaceFilePath(parentPath, file.name)
  if (
    !result ||
    !expectedPath ||
    result.name !== file.name ||
    typeof result.path !== 'string' ||
    workspacePathKey(result.path) !== workspacePathKey(expectedPath) ||
    !Number.isSafeInteger(result.size) ||
    result.size < 0 ||
    typeof result.sha256 !== 'string' ||
    (result.status === 'uploaded' &&
      (!/^[a-f0-9]{64}$/.test(result.sha256) ||
        (result.revision !== null && (typeof result.revision !== 'string' || !result.revision)))) ||
    (result.status === 'conflict' &&
      (typeof result.revision !== 'string' ||
        !result.revision ||
        (result.sha256 !== '' && !/^[a-f0-9]{64}$/.test(result.sha256)))) ||
    (result.status !== 'uploaded' && result.status !== 'conflict') ||
    (result.status === 'uploaded' && result.size !== file.size)
  ) {
    throw new Error(i18n.t('common:workspace_upload_invalid'))
  }
}
export const uploadWorkspaceFile: NonNullable<WorkspaceFileApi['uploadWorkspaceFile']> = async (
  deviceId,
  workspacePath,
  parentPath,
  file,
  options
) => {
  const currentAccount = captureAccountContextRevision()
  let scopeToken: string | undefined
  const check = () => {
    if (options?.signal?.aborted || !currentAccount(deviceId))
      throw new DOMException('Upload cancelled', 'AbortError')
  }
  const request = <T>(method: string, params: Record<string, unknown>) =>
    requestLocalExecutor<T>('runtime.workspaceFiles.request', {
      deviceId,
      workspacePath,
      method,
      params,
      expectedScopeToken: scopeToken,
    })
  if (file.size > LIMIT) throw new Error(i18n.t('common:workspace_upload_limit'))
  check()
  let uploadId: string | undefined
  let attachmentPath: string | undefined
  let published = false
  try {
    options?.onPhase?.('uploading')
    const started = await request<{ upload_id: string; scopeToken: string }>(
      'attachment/upload/start',
      {
        filename: file.name,
        size: file.size,
      }
    )
    uploadId = started.upload_id
    scopeToken = started.scopeToken
    if (typeof uploadId !== 'string' || !uploadId || typeof scopeToken !== 'string' || !scopeToken)
      throw new Error(i18n.t('common:workspace_upload_invalid'))
    for (let offset = 0, index = 0; offset < file.size; offset += CHUNK, index += 1) {
      check()
      const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer())
      let binary = ''
      for (let part = 0; part < bytes.length; part += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(part, part + 0x8000))
      check()
      await request('attachment/upload/chunk', {
        upload_id: uploadId,
        index,
        content_base64: btoa(binary),
      })
      options?.onProgress?.(Math.min(file.size, offset + bytes.length), file.size)
    }
    check()
    const staged = await request<{ path: string }>('attachment/upload/finish', {
      upload_id: uploadId,
    })
    uploadId = undefined
    attachmentPath = staged.path
    if (typeof attachmentPath !== 'string' || !attachmentPath)
      throw new Error(i18n.t('common:workspace_upload_invalid'))
    let expectedRevision: string | undefined
    for (;;) {
      check()
      options?.onPhase?.('saving')
      const result = await request<WorkspaceUploadResult>('workspace/file/importAttachment', {
        attachmentPath,
        parentPath,
        filename: file.name,
        overwrite: expectedRevision !== undefined,
        expectedRevision,
      })
      receipt(result, parentPath, file)
      if (result.status === 'uploaded') {
        published = true
        return result
      }
      if (result.status !== 'conflict' || !result.revision)
        throw new Error(i18n.t('common:workspace_upload_invalid'))
      check()
      options?.onPhase?.('confirming')
      if (!options?.onConflict || !(await options.onConflict(result)))
        throw new DOMException('Upload cancelled', 'AbortError')
      expectedRevision = result.revision
    }
  } finally {
    // Account changes dispose the original owner's connection. Never send old
    // resource identities to the newly selected account during cleanup.
    if (currentAccount(deviceId)) {
      if (uploadId)
        await request('attachment/upload/cancel', { upload_id: uploadId }).catch(() => {})
      if (attachmentPath && !published)
        await request('attachment/delete', { path: attachmentPath }).catch(() => {})
    }
  }
}
