import { beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createElement } from 'react';
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup(element: React.ReactNode): string };
const observed = vi.hoisted(() => ({ create: vi.fn(), state: null as any }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (initial: unknown) => [initial === false ? true : initial, () => {}] }));
vi.mock('@/components/ui', () => ({ Button: 'button', Field: 'input' }));
vi.mock('@/components/settings/settings-layout', () => ({ SettingsGroup: 'section' }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}) }));
vi.mock('@/components/settings/SettingsTargetContext', () => ({ useSettingsTarget: () => ({ ready: true, targetIdentity: 'account-target',
  profile: { id: 'owned' }, server: { id: 'owned-target' }, servers: [{ id: 'same-label-source', label: 'Source label' }], workspacePath: '/owned' }) }));
vi.mock('@/runtime/migration-source/private-credential-controller', () => ({ MobilePrivateCredentialController: class {
  constructor(options: unknown) { observed.create(options); } snapshot = () => observed.state; subscribe = () => () => {}; activate() {} dispose() {}
} }));
import { MobileMigrationClient } from '@/runtime/migration-client';
import { MigrationPrivateCredentials } from './MigrationPrivateCredentials.web';
import { MigrationProblem } from './WorkbenchUi';
import { migrationPrivateEn } from '@/i18n/locales/migration-private.en';
import { migrationPrivateZhCN } from '@/i18n/locales/migration-private.zh-CN';
import examples from '../../../../../../shared/generated/examples.migration-source-credentials.json';
const job = { source: 'codex', job: { jobId: 'mig-owned', sourceId: 'owned', status: 'ready', sequence: 7, totalItems: 1, committedItems: 0, requiresActionItems: 0 },
  plans: [], issues: [], batch: { planId: 'plan-owned', selectedItems: 1, totalActions: 1, committedActions: 0, unresolvedActions: 1 } };
const props = (caps = {}) => ({ client: new MobileMigrationClient(vi.fn(), caps, { read: async () => [], put: async () => {} }, () => true), job: job as never, onPrepared: vi.fn() });
beforeEach(() => { observed.create.mockClear(); observed.state = { busy: false, controlBusy: false, error: null, page: null, selected: null, device: null,
  candidates: null, selections: {}, records: [], input: null, result: null, included: [], observed: {}, workers: {}, prepareUnknown: false }; });
it('hides the metadata entrance on old targets before reading storage or opening a child', () => {
  expect(renderToStaticMarkup(createElement(MigrationPrivateCredentials, props()))).toBe(''); expect(observed.create).not.toHaveBeenCalled();
});
it('does not infer private-parent capabilities from ordinary RPC and requires explicit source selection', () => {
  observed.state.selected = { requestId: 'original-transfer', entryId: 'e0000-0000', sourceBindingRevision: 'original-revision' };
  const html = renderToStaticMarkup(createElement(MigrationPrivateCredentials, props({ migrationSourceCredentialSourcesV1: true })));
  expect(html).toContain('migration-private-sources'); expect(html).toContain('migration-private-device-same-label-source');
  expect(html).toContain('migration-private-candidates'); expect(html).toContain('disabled'); expect(html).not.toContain('migration-private-transfer');
  expect(observed.create.mock.calls[0][0].target).toEqual({ id: 'owned-target', workspacePath: '/owned' });
});
it('projects unknown workers and original IDs without rendering a raw secret value or assuming prepared means published', () => {
  observed.state.input = { locator: { offerId: 'original-offer' } };
  observed.state.prepareUnknown = true;
  const html = renderToStaticMarkup(createElement(MigrationPrivateCredentials, props({ migrationSourceCredentialSourcesV1: true })));
  expect(html).toContain('original-offer'); expect(html).toContain('Worker state unobserved');
  expect(html).toContain('migration-private-resume-source'); expect(html).toContain('disabled');
  expect(html).toContain('The preparation reply was not confirmed'); expect(html).not.toContain('type="password"');
});
it('bounds declared private field selectors to ten rows and retains all fields only in the typed candidate', () => {
  observed.state.candidates = { items: [{ kind: 'mcp', itemId: 'original-mcp', sourceName: 'notes', issueCode: null,
    targets: [{ kind: 'mcp', targetName: 'saved-target' }], fields: Array.from({ length: 12 }, (_, index) => ({ kind: 'environment', name: `FIELD_${index}` })) }] };
  const html = renderToStaticMarkup(createElement(MigrationPrivateCredentials, props({ migrationSourceCredentialSourcesV1: true })));
  expect(html.match(/migration-private-field-original-mcp-/g)).toHaveLength(10);
  expect(html).toContain('FIELD_9'); expect(html).not.toContain('FIELD_10');
});
it('keeps both locales complete with the same runtime interpolation fields', () => {
  expect(Object.keys(migrationPrivateEn).sort()).toEqual(Object.keys(migrationPrivateZhCN).sort());
  for (const [key, text] of Object.entries(migrationPrivateEn)) {
    const fields = (value: string) => [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
    expect(text.length).toBeGreaterThan(0); expect(migrationPrivateZhCN[key].length).toBeGreaterThan(0);
    expect(fields(text)).toEqual(fields(migrationPrivateZhCN[key]));
  }
});
it('keeps receipt reading and unobserved target cancellation reachable while the original transfer awaits its reply', () => {
  observed.state.busy = true; observed.state.input = { locator: { offerId: 'original-offer' } };
  const html = renderToStaticMarkup(createElement(MigrationPrivateCredentials, props({ migrationSourceCredentialSourcesV1: true })));
  const button = (id: string) => html.match(new RegExp(`<button[^>]*testID="${id}"[^>]*>`, 'i'))?.[0] ?? '';
  expect(button('migration-private-read')).not.toContain('disabled'); expect(button('migration-private-read')).not.toBe('');
  expect(button('migration-private-cancel-target')).not.toContain('disabled');
  expect(button('migration-private-resume-target')).toContain('disabled');
  expect(button('migration-private-cancel-source')).toContain('disabled');
  observed.state.controlBusy = true;
  const controlling = renderToStaticMarkup(createElement(MigrationPrivateCredentials, props({ migrationSourceCredentialSourcesV1: true })));
  expect(controlling.match(/<button[^>]*testID="migration-private-read"[^>]*>/i)?.[0]).toContain('disabled');
  expect(controlling.match(/<button[^>]*testID="migration-private-cancel-target"[^>]*>/i)?.[0]).toContain('disabled');
});

it('shows native preparation separately after cache loss and never calls it published or supplies worker evidence', () => {
  observed.state.selected = {}; observed.state.preparation = examples.MigrationSourceCredentialPreparationResult.find(row => row.value.phase === 'prepared')!.value;
  const html = renderToStaticMarkup(createElement(MigrationPrivateCredentials, props({ migrationSourceCredentialSourcesV1: true })));
  expect(html).toContain('migration-private-preparation-read'); expect(html).toContain('The original offer set was prepared.');
  expect(html).toContain('Preparation is not publication'); expect(html).not.toContain('migration-private-preparation-restore');
  expect(html).not.toContain('migration-private-transfer'); expect(html).not.toContain('Worker stopped');
});

it('pages the complete recovered set by ten and offers explicit restore only for pending status', () => {
  observed.state.selected = {}; const value = examples.MigrationSourceCredentialPreparationResult.find(row => row.value.phase === 'pending')!.value;
  observed.state.preparation = { ...value, offerIds: Array.from({ length: 16 }, (_, at) => `${String(at + 1).padStart(8, '0')}-1111-4111-8111-111111111111`) };
  const html = renderToStaticMarkup(createElement(MigrationPrivateCredentials, props({ migrationSourceCredentialSourcesV1: true })));
  expect(html).toContain('migration-private-preparation-restore'); expect(html).toContain('00000010-1111-4111-8111-111111111111');
  expect(html).not.toContain('00000011-1111-4111-8111-111111111111'); expect(html).toContain('Closing this view does not roll back');
});

it('explains only the two exact preparation barriers without admitting arbitrary private error text', () => {
  for (const code of ['private_credentials_preparation_pending', 'private_credentials_publication_unknown']) {
    const html = renderToStaticMarkup(createElement(MigrationProblem, { code }));
    expect(html).toContain('Read the original preparation intent first'); expect(html).toContain(code);
  }
  const html = renderToStaticMarkup(createElement(MigrationProblem, { code: 'private_credentials_SYNTHETIC_NEVER_DISPLAY' }));
  expect(html).not.toContain('SYNTHETIC_NEVER_DISPLAY'); expect(html).toContain('migration_request_failed');
});
