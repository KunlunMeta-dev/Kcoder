type MigrationErrorArea = 'resources' | 'definitions' | 'source_upload';

const errorSuffixes: Record<MigrationErrorArea, Readonly<Record<string, string>>> = {
  resources: {
    readFailed: 'read_failed',
    increaseUnknown: 'increase_unknown',
    recoveryUnavailable: 'recovery_unavailable',
    invalidLimits: 'invalid_limits',
    confirmationRequired: 'confirmation_required',
    scopeChanged: 'scope_changed',
    jobNotMutable: 'job_not_mutable',
    updateRequired: 'update_required',
    selectorChanged: 'selector_changed',
  },
  definitions: {
    failed: 'failed',
    scanUnknown: 'scan_unknown',
    updateRequired: 'update_required',
  },
  source_upload: {
    selectionMismatch: 'selection_mismatch',
    recoveryUnavailable: 'recovery_unavailable',
    recoveryLimit: 'recovery_limit',
    outcomeUnknown: 'outcome_unknown',
    selectionFailed: 'selection_failed',
    localStopped: 'local_stopped',
    migration_source_upload_update_required: 'migration_source_upload_update_required',
    productUnknown: 'product_unknown',
    noSafeFiles: 'no_safe_files',
    rawFileCount: 'raw_file_count',
  },
};

const prefixes: Record<MigrationErrorArea, string> = {
  resources: 'migration_resources.errors',
  definitions: 'migration_definitions',
  source_upload: 'migration_source_upload.errors',
};

/** Translate known migration controller codes without changing their domain values. */
export function migrationErrorTranslationKey(area: MigrationErrorArea, code: string): string {
  const areaSuffixes = errorSuffixes[area];
  const suffix = Object.hasOwn(areaSuffixes, code) ? areaSuffixes[code] : 'unknown_error';
  return `${prefixes[area]}.${suffix}`;
}
