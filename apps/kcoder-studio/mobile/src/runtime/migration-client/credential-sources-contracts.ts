import * as C from '../../../../shared/generated/contracts';
import { CREDENTIAL_SOURCES_CAPABILITY, CREDENTIAL_SOURCES_METHOD } from '../../../../shared/migrationCredentialSources';

export interface CredentialSourcesCalls {
  credentialSources: [C.MigrationSourceCredentialSourcesParams, C.MigrationSourceCredentialSourcesResult];
}

export const CREDENTIAL_SOURCES_CALLS = {
  credentialSources: {
    method: CREDENTIAL_SOURCES_METHOD,
    caps: [CREDENTIAL_SOURCES_CAPABILITY],
    read: true,
    params: C.isMigrationSourceCredentialSourcesParams,
    result: C.isMigrationSourceCredentialSourcesResult,
    rows: ['items'],
  },
};
