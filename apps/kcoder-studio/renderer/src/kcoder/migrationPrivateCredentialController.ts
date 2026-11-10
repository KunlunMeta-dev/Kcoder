import { createRandomUuid } from '@/lib/random-id'
import { PrivateCredentialController } from '../../../shared/migrationPrivateCredentialController'
import type { MigrationJobReadResult } from '../../../shared/generated/contracts'
import { captureAccountContextRevision } from './accountContextEvents'
import { createMigrationApi } from './gatewayMigration'
import { createMigrationPrivateCredentialClient } from './gatewayMigrationPrivateCredentials'
import { createMigrationSourceSessionClient } from './gatewayMigrationSourceSessions'
import { migrationSourceRecoveryScope } from './migrationSourceTransferScope'
import type { GatewayServer } from './gatewayRpc'

interface Options {
  target: GatewayServer; job: MigrationJobReadResult; isCurrent(): boolean
  onPrepared(job: MigrationJobReadResult): void; storage?: Storage
}
/** Cookie/account fencing stays in Studio; both clients share the same receipt state machine. */
export class StudioPrivateCredentialController extends PrivateCredentialController {
  constructor(options: Options) {
    const accountCurrent = captureAccountContextRevision(), scope = migrationSourceRecoveryScope(options.target)
    const used = new Set([options.target.id])
    const accountOwned = () => [...used].every(id => accountCurrent(id)) && migrationSourceRecoveryScope(options.target) === scope
    const current = () => options.isCurrent() && accountOwned()
    const api = createMigrationApi(options.target.id, options.target.workspacePath)
    super({ target: options.target, scope, job: options.job, isCurrent: current, onPrepared: options.onPrepared,
      storage: options.storage, requestId: createRandomUuid,
      native: { available: current, credentialSources: input => api.credentialSources(input), batchRead: input => api.readBatch(input.jobId) },
      sessions: captureScope => {
        const client = createMigrationSourceSessionClient({ captureScope: () => accountOwned() ? captureScope() : '' })
        return { open: input => { used.add(input.targetId); return client.open(input) }, close: input => client.close(input) }
      },
      privateClient: (captureScope, signal) => createMigrationPrivateCredentialClient({ captureScope: () => accountOwned() ? captureScope() : '' }, signal),
    })
  }
}
