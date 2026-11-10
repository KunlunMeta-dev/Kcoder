import { migrationRequestId } from '../migration-client';
import type { MigrationSourceKind, MigrationSourceSessionParams } from '../../../../shared/generated/contracts';
import type { createMigrationSourceSessionClient } from './sessions';
import { MigrationSourceHttpError } from './http';
/** Lexical guidance only. The selected source's Native process authorizes the directory handle. */
export function validSourceDirectory(value: string): boolean {
  return new TextEncoder().encode(value).length <= 4096 && !/[\p{Cc}]/u.test(value)
    && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
}
/** Keep an uncertain grant on its original child and selection; never fall back to home. */
export function createSourceDirectoryIntent(source: MigrationSourceKind, directory?: string) {
  if (directory !== undefined && !validSourceDirectory(directory)) throw new MigrationSourceHttpError('source_transfer_directory_invalid', false);
  const params = directory === undefined ? null : { selectionId: migrationRequestId(), source, directory };
  let expires = 0;
  return {
    matches: (kind: MigrationSourceKind, path?: string) => kind === source && path === directory,
    explicit: directory !== undefined,
    async authorize(client: ReturnType<typeof createMigrationSourceSessionClient>, session: MigrationSourceSessionParams, current: () => boolean) {
      if (!params) return Number.POSITIVE_INFINITY;
      if (!current()) throw new MigrationSourceHttpError('source_transfer_authority_changed', false);
      if (expires > performance.now()) return expires;
      const started = performance.now(), result = await client.selectDirectory(session, params);
      if (!current()) throw new MigrationSourceHttpError('source_transfer_authority_changed', false);
      if (result.source !== source || result.remainingMs <= performance.now() - started) throw new MigrationSourceHttpError('source_transfer_directory_expired', false);
      expires = started + result.remainingMs;
      return expires;
    },
  };
}
