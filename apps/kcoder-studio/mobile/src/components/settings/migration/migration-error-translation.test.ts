import { describe, expect, test } from 'vitest';
import { en } from '@/i18n/locales/en';
import { zhCN } from '@/i18n/locales/zh-CN';
import { migrationErrorTranslationKey } from './migration-error-translation';

const knownErrors = [
  { area: 'resources', code: 'readFailed', key: 'migration_resources.errors.read_failed' },
  { area: 'resources', code: 'increaseUnknown', key: 'migration_resources.errors.increase_unknown' },
  { area: 'resources', code: 'recoveryUnavailable', key: 'migration_resources.errors.recovery_unavailable' },
  { area: 'resources', code: 'invalidLimits', key: 'migration_resources.errors.invalid_limits' },
  { area: 'resources', code: 'confirmationRequired', key: 'migration_resources.errors.confirmation_required' },
  { area: 'resources', code: 'scopeChanged', key: 'migration_resources.errors.scope_changed' },
  { area: 'resources', code: 'jobNotMutable', key: 'migration_resources.errors.job_not_mutable' },
  { area: 'resources', code: 'updateRequired', key: 'migration_resources.errors.update_required' },
  { area: 'resources', code: 'selectorChanged', key: 'migration_resources.errors.selector_changed' },
  { area: 'definitions', code: 'failed', key: 'migration_definitions.failed' },
  { area: 'definitions', code: 'scanUnknown', key: 'migration_definitions.scan_unknown' },
  { area: 'definitions', code: 'updateRequired', key: 'migration_definitions.update_required' },
  { area: 'source_upload', code: 'selectionMismatch', key: 'migration_source_upload.errors.selection_mismatch' },
  { area: 'source_upload', code: 'recoveryUnavailable', key: 'migration_source_upload.errors.recovery_unavailable' },
  { area: 'source_upload', code: 'recoveryLimit', key: 'migration_source_upload.errors.recovery_limit' },
  { area: 'source_upload', code: 'outcomeUnknown', key: 'migration_source_upload.errors.outcome_unknown' },
  { area: 'source_upload', code: 'selectionFailed', key: 'migration_source_upload.errors.selection_failed' },
  { area: 'source_upload', code: 'localStopped', key: 'migration_source_upload.errors.local_stopped' },
  { area: 'source_upload', code: 'migration_source_upload_update_required', key: 'migration_source_upload.errors.migration_source_upload_update_required' },
  { area: 'source_upload', code: 'productUnknown', key: 'migration_source_upload.errors.product_unknown' },
  { area: 'source_upload', code: 'noSafeFiles', key: 'migration_source_upload.errors.no_safe_files' },
  { area: 'source_upload', code: 'rawFileCount', key: 'migration_source_upload.errors.raw_file_count' },
] as const;

describe('migration error translation keys', () => {
  test('maps every controller error code to a translated key in both locales', () => {
    for (const { area, code, key } of knownErrors) {
      const translatedKey = migrationErrorTranslationKey(area, code);
      expect(translatedKey, `${area}.${code}`).toBe(key);
      expect(en[translatedKey], `English translation for ${area}.${code}`).toBeTruthy();
      expect(zhCN[translatedKey], `Simplified Chinese translation for ${area}.${code}`).toBeTruthy();
      expect(en[translatedKey]).not.toBe(translatedKey);
      expect(zhCN[translatedKey]).not.toBe(translatedKey);
    }
  });

  test('uses a localized generic message for codes outside the migration presentation map', () => {
    for (const area of ['resources', 'definitions', 'source_upload'] as const) {
      for (const code of ['/private/raw-domain-code', 'constructor', 'toString', '__proto__']) {
        const key = migrationErrorTranslationKey(area, code);
        expect(key, `${area}.${code}`).toMatch(/\.unknown_error$/);
        expect(en[key]).toBeTruthy();
        expect(zhCN[key]).toBeTruthy();
        expect(en[key]).not.toContain(code);
        expect(zhCN[key]).not.toContain(code);
      }
    }
  });
});
