import { createRequire } from 'node:module';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { MobileMigrationClient } from '@/runtime/migration-client';
import { MigrationHistoryFamilySources } from './MigrationHistoryFamilySources';
import { MigrationHistoryFamilyLabel } from './MigrationHistoryFamilyChoice';
import { migrationHistoryFamiliesEn } from '@/i18n/locales/migration-history-families.en';
import { migrationHistoryFamiliesZhCN } from '@/i18n/locales/migration-history-families.zh-CN';
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup(node: React.ReactNode): string };
vi.mock('@/components/ui', () => ({ Button: 'button', Field: 'input' }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}) }));

it('makes indexing explicit, leaves old targets on basic browsing and sends no request on render', () => {
  const rpc = vi.fn(), client = new MobileMigrationClient(rpc, { migrationHistoryJobsV1: true, migrationBatchWorkersV1: true }, { read: async () => [], put: async () => {} }, () => true);
  const html = renderToStaticMarkup(createElement(MigrationHistoryFamilySources, { client, available: 64, disabled: false, resetKey: 0,
    onStart: vi.fn(), onBusy: vi.fn(), onSelection: vi.fn() }));
  expect(html).toContain('migration-history-families-discover'); expect(html).toContain('disabled'); expect(html).toContain('No basic scan was started automatically');
  expect(rpc).not.toHaveBeenCalled();
});
it('distinguishes a cached ancestor from an absent one without synthesizing a parent selection', () => {
  const html = renderToStaticMarkup(createElement(MigrationHistoryFamilyLabel, { group: { sessionId: 'original-root', title: 'Original root title', parentObserved: true,
    parentOnPage: false, related: true, lineageIssue: null } }));
  expect(html).toContain('Original root title'); expect(html).toContain('The ancestor was observed on another page'); expect(html).not.toContain('source-browser-select');
});
it('keeps both locale dictionaries complete and interpolation compatible', () => {
  expect(Object.keys(migrationHistoryFamiliesEn).sort()).toEqual(Object.keys(migrationHistoryFamiliesZhCN).sort());
  for (const key of Object.keys(migrationHistoryFamiliesEn)) {
    expect(migrationHistoryFamiliesEn[key]).not.toMatch(/\{\{/); expect(migrationHistoryFamiliesZhCN[key]).not.toMatch(/\{\{/);
    expect(migrationHistoryFamiliesZhCN[key].length).toBeGreaterThan(0);
  }
});
