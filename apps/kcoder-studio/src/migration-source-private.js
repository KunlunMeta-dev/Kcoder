// This module belongs to the trusted Gateway-to-Native lane, never client JSON.
export const PRIVATE_MIGRATION_SOURCE_FIELD = 'kcoderPrivateMigrationSource';
export const MIGRATION_SOURCE_INTERNAL_PREFIX = 'migration/sourceTransfer/internal/';
export const MIGRATION_SOURCE_INTERNAL_CAPABILITY = 'migrationSourceTransferInternalV1';
export const MIGRATION_SOURCE_PARENT_LAUNCH_CAPABILITY = 'migrationSourceTransferParentLaunchV1';
export const MIGRATION_SOURCE_TARGET_RECOVERY_CAPABILITY = 'migrationSourceTransferTargetRecoveryV1';
export const MIGRATION_SOURCE_ATTEMPT_CAPABILITY = 'migrationSourceTransferAttemptsV1';
export const MIGRATION_SOURCE_ADOPTION_CAPABILITY = 'migrationSourceTransferAdoptionV1';
export const MIGRATION_SOURCE_UPLOADED_CAPABILITY = 'migrationSourceTransferUploadedV1';
export const MIGRATION_SOURCE_PRIVATE_CREDENTIALS_CAPABILITY = 'migrationSourceTransferPrivateCredentialsV1';
export const MIGRATION_SOURCE_PRIVATE_CREDENTIAL_SOURCE_OBSERVATION_CAPABILITY = 'migrationSourceTransferPrivateCredentialSourceObservationV1';
export const MIGRATION_SOURCE_PRIVATE_CREDENTIAL_PREPARATIONS_CAPABILITY = 'migrationSourceTransferPrivateCredentialPreparationsV1';
export const MIGRATION_SOURCE_PRIVATE_CREDENTIAL_BUNDLES_CAPABILITY = 'migrationSourceTransferPrivateCredentialBundlesV1';
export const MIGRATION_SOURCE_DEFINITIONS_CAPABILITY = 'migrationSourceTransferDefinitionsV1';
export const MIGRATION_SOURCE_PROJECTS_CAPABILITY = 'migrationSourceTransferProjectsV1';
export const MIGRATION_SOURCE_PLUGINS_CAPABILITY = 'migrationSourceTransferPluginsV1';
export const MIGRATION_SOURCE_UPLOADED_PLUGINS_CAPABILITY = 'migrationSourceUploadedPluginsV1';
export const MIGRATION_SOURCE_MEMORY_CAPABILITY = 'migrationSourceTransferMemoryV1';
export const MIGRATION_SOURCE_ASSET_IDENTITY_CAPABILITY = 'migrationSourceTransferAssetIdentityV1';
export const MIGRATION_SOURCE_METHODS = new Set([
  'identity', 'peer/accept', 'peer/recover-target', 'source/prepare', 'source/capture', 'source/manifest',
  'source/chunk', 'source/state', 'source/intent', 'source/cancel', 'source/resume', 'target/grant',
  'target/begin', 'target/part/read', 'target/part/write', 'target/finish',
  'target/receipt', 'target/state', 'target/summary', 'target/cancel', 'target/resume',
  'target/attempt/read', 'target/attempt/claim', 'target/attempt/release',
  'target/received/read', 'target/adoption/prepare', 'target/adoption/read', 'target/adoption/resume', 'target/adoption/cancel',
  'source/private/seal', 'source/private/read', 'source/private/observe', 'source/private/cancel', 'source/private/resume',
  'target/private/candidates', 'target/private/offer', 'target/private/read', 'target/private/accept', 'target/private/cancel', 'target/private/resume',
  'target/private/prepare-status', 'target/private/prepare', 'target/private/release',
].map(method => MIGRATION_SOURCE_INTERNAL_PREFIX + method));

export class MigrationSourceBridgeError extends Error {
  constructor(reason = 'source_transfer_outcome_unknown') {
    super('Migration source transfer could not be confirmed');
    this.name = 'MigrationSourceBridgeError';
    this.reason = reason;
  }
}

// Inspect property tokens, including duplicate or escaped keys that JSON.parse
// would otherwise project away. The caller has already checked bounded JSON.
export function hasPrivateMigrationSourceField(raw) {
  raw = typeof raw === 'string' ? raw : raw.toString('utf8');
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== '"') continue;
    const start = index++;
    while (index < raw.length && raw[index] !== '"') {
      if (raw[index] === '\\') index++;
      index++;
    }
    let next = index + 1;
    while (next < raw.length && /\s/.test(raw[next])) next++;
    if (raw[next] === ':' && JSON.parse(raw.slice(start, index + 1)) === PRIVATE_MIGRATION_SOURCE_FIELD) return true;
  }
  return false;
}

export function migrationSourcePrivateFrame(message, proof) {
  if (!MIGRATION_SOURCE_METHODS.has(message.method)) throw new MigrationSourceBridgeError('source_transfer_method_unavailable');
  if (message.method.endsWith('/peer/accept')) {
    if (!proof || proof.version !== 1 || proof.requestId !== message.params?.requestId) {
      throw new MigrationSourceBridgeError('source_transfer_authority_unavailable');
    }
    return { ...message, [PRIVATE_MIGRATION_SOURCE_FIELD]: proof };
  }
  if (proof !== undefined) throw new MigrationSourceBridgeError('source_transfer_invalid_request');
  return message;
}
