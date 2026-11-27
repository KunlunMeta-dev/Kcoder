import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { MigrationHistoryGroups } from './MigrationHistoryGroup'
import type { HistorySourceSummary } from '../../../../shared/generated/contracts'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string, values?: { title?: string }) => `${key}${values?.title ? `: ${values.title}` : ''}` }) }))
const row = (sourceHandle: string, patch: Partial<HistorySourceSummary> = {}): HistorySourceSummary => ({ source: 'claude-code', sourceHandle, sourceSessionId: 'main', title: `Original ${sourceHandle}`, agentId: null, parentSessionId: null, bytes: 2, archived: false, compressed: false, importIssues: [], previewIncomplete: false, ...patch })

it('renders family headings without making a hidden parent selectable or losing per-artifact titles', () => {
  const items = [row('child', { parentSessionId: 'main', agentId: 'a' }), row('parent'), row('orphan', { sourceSessionId: 'fork', parentSessionId: 'absent' })]
  render(<MigrationHistoryGroups items={items}>{item => <label key={item.sourceHandle}><input type="checkbox"/>{item.title}</label>}</MigrationHistoryGroups>)
  expect(screen.getAllByTestId('migration-history-group')).toHaveLength(2)
  expect(screen.getAllByRole('checkbox')).toHaveLength(3)
  expect(screen.getAllByRole('checkbox')[0]).toHaveAccessibleName('Original parent')
  expect(screen.getByText('history.group: Original parent')).toBeVisible()
  expect(screen.getByText('history.group: absent')).toBeVisible()
  expect(screen.getByText('history.group_parent_elsewhere')).toBeVisible()
  expect(screen.getByText('Original child')).toBeVisible()
})
