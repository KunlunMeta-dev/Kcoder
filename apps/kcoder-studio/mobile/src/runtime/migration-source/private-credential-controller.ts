import type { GatewayProfile } from '@/gateway/types';
import { migrationRequestId, type MobileMigrationClient, type MigrationJobReadResult } from '../migration-client';
import { createMigrationPrivateCredentialClient } from './private-credentials';
import { createMigrationSourceSessionClient } from './sessions';
import { PrivateCredentialController } from '../../../../shared/migrationPrivateCredentialController';
import type { SourceTarget } from './catalog';
export type { PrivateCredentialSnapshot } from '../../../../shared/migrationPrivateCredentialController';

interface Options {
  profile: GatewayProfile; target: SourceTarget; scope: string; client: MobileMigrationClient;
  job: MigrationJobReadResult; isCurrent(): boolean; onPrepared(job: MigrationJobReadResult): void; storage?: Storage;
}
/** Bearer/profile fencing stays in Mobile transports; state transitions are shared with Studio. */
export class MobilePrivateCredentialController extends PrivateCredentialController {
  constructor(options: Options) {
    super({ target: options.target, scope: options.scope, job: options.job, isCurrent: options.isCurrent,
      onPrepared: options.onPrepared, storage: options.storage, requestId: migrationRequestId,
      native: { available: () => options.client.available(),
        credentialSources: input => options.client.call('credentialSources', input),
        batchRead: input => options.client.call('batchRead', input) },
      sessions: captureScope => createMigrationSourceSessionClient({ profile: options.profile, captureScope }),
      privateClient: (captureScope, signal?: () => AbortSignal) => createMigrationPrivateCredentialClient({ profile: options.profile, captureScope }, signal),
    });
  }
}
