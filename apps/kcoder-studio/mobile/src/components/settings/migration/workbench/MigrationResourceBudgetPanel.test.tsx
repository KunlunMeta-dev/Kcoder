import { beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup(element: React.ReactNode): string };
import { createElement } from 'react';
const observed = vi.hoisted(() => ({ state: null as any, create: vi.fn(), mutable: true }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (initial: unknown) => [initial === false ? true : initial, () => {}] }));
vi.mock('@/components/ui', () => ({ Button: 'button', Field: 'input' }));
vi.mock('@/components/settings/settings-layout', () => ({ SettingsGroup: 'section' }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}) }));
vi.mock('@/components/settings/SettingsTargetContext', () => ({ useSettingsTarget: () => ({ ready: true, targetIdentity: 'account-target-workspace' }) }));
vi.mock('../../../../../../shared/migrationResourceBudgetController.mjs', () => ({ createResourceBudgetController: (options: any) => { observed.create(options); return { getSnapshot: () => observed.state, subscribe: () => () => {}, read() {}, activate() {}, dispose() {} }; } }));
import { MobileMigrationClient } from '@/runtime/migration-client';
import { MigrationResourceBudgetPanel } from './MigrationResourceBudgetPanel.web';
const job = { source: 'codex', job: { jobId: 'mig-owned', sourceId: 'source', sequence: 8, status: 'completed_with_issues', totalItems: 2, committedItems: 1, requiresActionItems: 0 }, plans: [], issues: [], batch: { planId: 'plan-owned', selectedItems: 2, totalActions: 2, committedActions: 1, unresolvedActions: 1 } };
const client = (enabled = true) => new MobileMigrationClient(vi.fn(), { migrationResourceBudgetV1: enabled }, { read: async () => [], put: async () => {} }, () => true);
beforeEach(() => { observed.create.mockClear(); observed.state = { busy: false, view: { phase: 'active', jobId: 'mig-owned', limits: { maxTotalBytes: 1024, maxPayloadFiles: 6, minFreeBytes: 1048576, minFreeFileNodes: 0 }, policyRevision: 3, usage: { committedBytes: 512, reservedBytes: 88, committedFiles: 5, reservedFiles: 5 } }, receipt: null, pending: null, checked: true, history: [], recoveryBlocked: false, error: null }; });
it('static Web projection hides old targets before opening local recovery or reading Native', () => {
  expect(renderToStaticMarkup(createElement(MigrationResourceBudgetPanel, { client: client(false), job: job as never }))).toBe('');
  expect(observed.create).not.toHaveBeenCalled();
});
it('static Web projection separates a historical receipt from current group facts and disallows a terminal increase', () => {
  observed.state.receipt = { jobId: 'mig-owned', requestId: 'original', previousRevision: 0, revision: 1, limits: { ...observed.state.view.limits, maxTotalBytes: 1000 } };
  const output = renderToStaticMarkup(createElement(MigrationResourceBudgetPanel, { client: client(), job: { ...job, job: { ...job.job, status: 'rolled_back' } } as never }));
  expect(output).toContain('migration-resource-current'); expect(output).toContain('migration-resource-receipt');
  expect(output).toContain('migration-resource-increase'); expect(observed.create.mock.calls[0][0].canIncrease()).toBe(false);
  expect(output).toContain('disabled');
});
