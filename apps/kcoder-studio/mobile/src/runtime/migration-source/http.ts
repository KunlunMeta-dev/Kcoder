import { gatewayRequest } from '@/gateway/http';
import type { GatewayProfile } from '@/gateway/types';
import { captureWorkspaceProfileIdentity, startWorkspaceProfileRpc } from '@/storage/workspace-profile-fence';

export class MigrationSourceHttpError extends Error {
  constructor(readonly code: string, readonly outcomeUnknown: boolean) { super(code); this.name = 'MigrationSourceHttpError'; }
}
export interface MigrationSourceHttpOptions { profile: GatewayProfile; captureScope(): string; }
const operations = {
  'source-session': new Set(['open', 'read', 'close', 'query']),
  'source-transfer': new Set(['run', 'read', 'cancel', 'target-read', 'target-cancel', 'target-resume', 'target-finish', 'received', 'adoption-prepare', 'adoption-read', 'adoption-resume', 'adoption-cancel']),
  'source-transfer/private': new Set(['candidates', 'run', 'read', 'source-read', 'prepare-status', 'cancel', 'resume', 'prepare', 'release']),
};
/** A finite Bearer-authenticated HTTP domain, never an arbitrary Native RPC tunnel. */
export function createMigrationSourceHttpTransport(options: MigrationSourceHttpOptions, lane: keyof typeof operations, readOnly: ReadonlySet<string>, validError?: (value: unknown) => boolean) {
  const authorization = captureWorkspaceProfileIdentity(options.profile);
  return async function request<T>(operation: string, input: unknown, validInput: (value: unknown) => boolean, validResult: (value: unknown) => value is T, signal?: AbortSignal): Promise<T> {
    const mutation = !readOnly.has(operation), scope = options.captureScope();
    if (!operations[lane].has(operation) || !validInput(input)) throw new MigrationSourceHttpError('source_transfer_invalid_request', false);
    if (!scope || signal?.aborted) throw new MigrationSourceHttpError('source_transfer_request_not_sent', false);
    const body = JSON.stringify(input);
    if (new TextEncoder().encode(body).length > 64 * 1024) throw new MigrationSourceHttpError('source_transfer_invalid_request', false);
    let sent = false;
    try {
      const started = await startWorkspaceProfileRpc(authorization, () => {
        if (options.captureScope() !== scope || signal?.aborted) throw new MigrationSourceHttpError('source_transfer_authority_changed', false);
        return gatewayRequest<unknown>(options.profile, `/api/migration/${lane}/${operation}`, { method: 'POST', body, signal, cache: 'no-store' }, { responseBytes: 2 * 1024 * 1024, beforeDispatch: () => {
          if (options.captureScope() !== scope || signal?.aborted) throw new MigrationSourceHttpError('source_transfer_authority_changed', false);
          sent = true;
        } });
      });
      const result = await started.response;
      if (options.captureScope() !== scope) throw new MigrationSourceHttpError('source_transfer_authority_changed', mutation);
      if (!validResult(result)) throw new MigrationSourceHttpError('source_transfer_invalid_response', mutation);
      return result;
    } catch (error) {
      if (error instanceof MigrationSourceHttpError) throw error;
      const code = error instanceof Error ? validError ? validError(error.message) ? error.message : null
        : error.message.match(/\bsource_transfer_[a-z_]+\b/)?.[0] : null;
      throw new MigrationSourceHttpError(code ?? 'source_transfer_outcome_unknown', sent && mutation);
    }
  };
}
