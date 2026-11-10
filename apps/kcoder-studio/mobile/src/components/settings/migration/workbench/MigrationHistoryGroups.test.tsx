import { createRequire } from 'node:module';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import type { HistorySourceSummary } from '../../../../../../shared/generated/contracts';
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup(element: React.ReactNode): string };
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}) }));
vi.mock('@/i18n', () => ({ t: (key: string, values?: { title?: string }) => `${key}${values?.title ? `: ${values.title}` : ''}` }));
import { MigrationHistoryGroups } from './MigrationHistoryGroups';

it('projects a continued family without inventing a main row or dropping the original child title', () => {
  const item: HistorySourceSummary = { source: 'claude-code', sourceHandle: 'child', sourceSessionId: 'parent', agentId: 'a', parentSessionId: 'parent', title: 'Original child', bytes: 5, archived: false, compressed: false, importIssues: [], previewIncomplete: false };
  const output = renderToStaticMarkup(createElement(MigrationHistoryGroups, { items: [item], children: row => createElement('button', { key: row.sourceHandle }, row.title) }));
  expect(output).toContain('migration_workbench.history_group: parent');
  expect(output).toContain('migration_workbench.history_parent_elsewhere');
  expect(output).toContain('Original child');
  expect(output.match(/<button/g)).toHaveLength(1);
});
