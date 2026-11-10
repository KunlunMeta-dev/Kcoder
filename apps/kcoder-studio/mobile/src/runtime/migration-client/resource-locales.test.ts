import { expect, it } from 'vitest';
import { migrationResourcesEn } from '@/i18n/locales/migration-resources.en';
import { migrationResourcesZhCN } from '@/i18n/locales/migration-resources.zh-CN';
import { t, setLocale } from '@/i18n';
it('registers matching budget keys and interpolation in the selected locale', () => {
  expect(Object.keys(migrationResourcesEn).sort()).toEqual(Object.keys(migrationResourcesZhCN).sort());
  for (const key of Object.keys(migrationResourcesEn) as Array<keyof typeof migrationResourcesEn>) {
    const fields = (text: string) => [...text.matchAll(/\{([^}]+)\}/g)].map(m => m[1]).sort();
    expect(fields(migrationResourcesEn[key])).toEqual(fields(migrationResourcesZhCN[key]));
  }
  setLocale('zh-CN'); expect(t('migration_resources.title')).toBe('迁移存储预算');
  setLocale('en'); expect(t('migration_resources.current', { revision: 3 })).toBe('Current observation · policy revision 3');
});
