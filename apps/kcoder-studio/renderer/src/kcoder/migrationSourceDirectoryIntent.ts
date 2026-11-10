import { createRandomUuid } from '@/lib/random-id'
import { MigrationSourceHttpError, type createMigrationSourceSessionClient } from './gatewayMigrationSourceSessions'
import { isMigrationSourceProductParams, type MigrationSourceProductParams, type MigrationSourceKind, type MigrationSourceSessionParams } from '../../../shared/generated/contracts'

/** Lexical guidance only; the source Native process owns OS/path/handle authorization. */
export function validSourceDirectory(value: string): boolean {
  return new TextEncoder().encode(value).length <= 4096 && !/[\p{Cc}]/u.test(value)
    && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value))
}

export type SourceDirectoryChoice = { explicit: boolean; path: string }
export const emptySourceDirectoryChoice = (): SourceDirectoryChoice => ({ explicit: false, path: '' })
export const sourceDirectoryChoiceReady = (value: SourceDirectoryChoice) => !value.explicit || validSourceDirectory(value.path)
export const sourceDirectoryArgument = (value: SourceDirectoryChoice) => value.explicit ? value.path : undefined

export type MigrationSourceLocation = string | MigrationSourceProductParams

/** A lost select reply keeps its original child/selection identity for explicit reconciliation. */
export function createMigrationSourceDirectoryIntent(source: MigrationSourceKind, directory?: MigrationSourceLocation) {
  if (typeof directory === 'string' && !validSourceDirectory(directory)) throw new MigrationSourceHttpError('source_transfer_directory_invalid', false)
  if (directory !== undefined && typeof directory !== 'string' && !isMigrationSourceProductParams(directory)) throw new MigrationSourceHttpError('source_transfer_uploaded_invalid', false)
  const uploaded = typeof directory === 'object' ? { operationId: directory.operationId, manifestSha256: directory.manifestSha256 } : null
  const params = typeof directory === 'string' ? { selectionId: createRandomUuid(), source, directory } : null
  let pending = false, authorized = false
  return {
    matches: (kind: MigrationSourceKind, path: MigrationSourceLocation | undefined) => source === kind && (uploaded
      ? typeof path === 'object' && path.operationId === uploaded.operationId && path.manifestSha256 === uploaded.manifestSha256
      : directory === path),
    pending: () => pending,
    authorize: async (client: ReturnType<typeof createMigrationSourceSessionClient>, session: MigrationSourceSessionParams, current: () => boolean) => {
      if ((!params && !uploaded) || authorized) return
      if (!current()) throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
      pending = true
      const started = performance.now()
      const result = uploaded ? await client.selectUploaded(session, uploaded) : await client.selectDirectory(session, params!)
      if (!current()) throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
      if (result.source !== source || result.remainingMs <= 0 || performance.now() - started >= result.remainingMs)
        throw new MigrationSourceHttpError(uploaded ? 'source_transfer_uploaded_expired' : 'source_transfer_directory_expired', false)
      authorized = true; pending = false
    },
  }
}
