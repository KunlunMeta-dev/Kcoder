import React from 'react';
import { createRequire } from 'node:module';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const locale = vi.hoisted(() => ({ value: 'en' }));
const uploadFixture = vi.hoisted(() => {
  const state = { busy: false, hashing: false, hashedBytes: 0, hashTotalBytes: 0, error: '', selected: null, selector: null, observed: null, files: null, cached: [], unknown: false, readAttempted: false };
  const manager = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    activate: vi.fn(), dispose: vi.fn(), clearSelected: vi.fn(), newSelection: vi.fn(),
  };
  return { state, manager };
});
vi.mock('@/i18n', async () => {
  const { en } = await import('@/i18n/locales/en'); const { zhCN } = await import('@/i18n/locales/zh-CN');
  return { t: (key: string) => (locale.value === 'en' ? en[key] : zhCN[key]) ?? key };
});
vi.mock('@/runtime/migration-source/upload-controller', () => ({ createSourceUploadController: () => uploadFixture.manager }));
vi.mock('@/runtime/migration-source/upload-api', () => ({ createMobileSourceUploadApi: () => ({}) }));
import { MigrationProblem } from '../workbench/WorkbenchUi';
import { MigrationUploadPanel } from './MigrationUploadPanel.web';
import { migrationSourceEn } from '@/i18n/locales/migration-source.en';
import { migrationSourceZhCN } from '@/i18n/locales/migration-source.zh-CN';
import { migrationSourceUploadEn } from '@/i18n/locales/migration-source-upload.en';
import { migrationSourceUploadZhCN } from '@/i18n/locales/migration-source-upload.zh-CN';
import type { MobileMigrationClient } from '@/runtime/migration-client';
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup(element: React.ReactNode): string };
afterEach(() => { vi.unstubAllGlobals(); });
it('localizes known Native configuration/directory failures without displaying untrusted private error text', () => {
  for (const value of ['en', 'zh-CN']) {
    locale.value = value;
    const html = renderToStaticMarkup(<MigrationProblem code="migration_settings_busy"/>);
    expect(html).toContain(value === 'en' ? 'configuration is busy' : '配置正被占用');
    const rejected = renderToStaticMarkup(<MigrationProblem code="/private/SYNTHETIC_CANARY"/>);
    expect(rejected).not.toContain('SYNTHETIC_CANARY'); expect(rejected).toContain('migration_request_failed');
  }
});
it('keeps source directory guidance and the known error set available in both locales', () => {
  expect(Object.keys(migrationSourceEn).sort()).toEqual(Object.keys(migrationSourceZhCN).sort());
  expect(migrationSourceEn['migration_source.directory_boundary']).toContain('not this browser');
  expect(migrationSourceZhCN['migration_source.directory_boundary']).toContain('不退回默认');
});
it('explains missing plugin project/transfer capability as an upgrade in both locales', () => {
  for (const value of ['en', 'zh-CN']) {
    locale.value = value;
    for (const code of ['migration_plugin_projects_update_required', 'source_transfer_plugins_update_required', 'source_transfer_plugin_projects_update_required']) {
      const html = renderToStaticMarkup(<MigrationProblem code={code}/>);
      expect(html).toContain(value === 'en' ? 'Upgrade the selected source and target' : '请升级所选来源端与目标端');
    }
  }
});

it('renders localized help in the real upload panel for all three selection modes', async () => {
  const client = { supports: () => true } as unknown as MobileMigrationClient;
  const expected = {
    en: {
      files: migrationSourceUploadEn['migration_source_upload.files_help'],
      directory: migrationSourceUploadEn['migration_source_upload.directory_help'],
      package: migrationSourceUploadEn['migration_source_upload.package_help'],
    },
    'zh-CN': {
      files: migrationSourceUploadZhCN['migration_source_upload.files_help'],
      directory: migrationSourceUploadZhCN['migration_source_upload.directory_help'],
      package: migrationSourceUploadZhCN['migration_source_upload.package_help'],
    },
  };

  vi.stubGlobal('localStorage', { length: 0, key: () => null, getItem: () => null, setItem: () => {} });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  for (const language of ['en', 'zh-CN'] as const) {
    locale.value = language;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<MigrationUploadPanel client={client} scope="test-scope" isCurrent={() => true} onReady={() => {}} onIdentity={() => {}} />);
    });
    try {
      for (const mode of ['files', 'directory', 'package'] as const) {
        if (mode !== 'files') {
          await act(async () => { renderer.root.findByProps({ testID: `source-upload-mode-${mode}` }).props.onPress(); });
        }
        const text = renderer.root.findAll(node => typeof node.props.children === 'string').map(node => node.props.children).join('\n');
        expect(text).toContain(expected[language][mode]);
        expect(text).not.toMatch(/migration_source_upload\.(?:filesHelp|directoryHelp|packageHelp|files_help|directory_help|package_help)/);
      }
    } finally {
      await act(async () => { renderer.unmount(); });
    }
  }
});
