import i18n from '@/i18n'

export const WORKSPACE_FILE_CHANGED_PREFIX = 'workspace_file_changed:'

export function workspaceFileChangedError(): Error {
  return new Error(`${WORKSPACE_FILE_CHANGED_PREFIX} the file changed while being read`)
}

export function isWorkspaceFileChangedError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(WORKSPACE_FILE_CHANGED_PREFIX)
}

export function workspaceBinaryRevisionUnavailableError(): Error {
  return new Error(i18n.t('common:workbench.workspace_file_revision_unavailable'))
}

export function normalizeWorkspaceChunkRevision(
  record: Record<string, unknown>,
  expectedRevision?: string
): { revision?: string } {
  // The Gateway sets this marker only after explicit capability negotiation.
  // An incidental revision from a legacy HTTP target is not a snapshot guarantee.
  if (record.revision_supported !== true) {
    if (expectedRevision !== undefined) throw workspaceBinaryRevisionUnavailableError()
    return {}
  }
  if (typeof record.revision !== 'string' || !record.revision.trim())
    throw new Error('Invalid workspace file chunk revision')
  if (expectedRevision !== undefined && record.revision !== expectedRevision)
    throw workspaceFileChangedError()
  return { revision: record.revision }
}
