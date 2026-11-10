import { privateCredentialClient, PRIVATE_CREDENTIAL_READ_ONLY, isPrivateCredentialError } from '../../../shared/migrationPrivateCredentials'
import { createMigrationSourceHttpTransport, type MigrationSourceHttpOptions } from './gatewayMigrationSourceHttp'

export function createMigrationPrivateCredentialClient(options: MigrationSourceHttpOptions, defaultSignal?: () => AbortSignal) {
  return privateCredentialClient(createMigrationSourceHttpTransport(options, 'source-transfer/private', PRIVATE_CREDENTIAL_READ_ONLY, isPrivateCredentialError), defaultSignal)
}
