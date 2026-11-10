import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { MigrationHistoryWorkspace } from './MigrationHistoryWorkspace'
const { api } = vi.hoisted(() => ({ api: { historyDiscover: vi.fn(), historySources: vi.fn(), historyJobs: vi.fn(), historyCreate: vi.fn(), historyRun: vi.fn(), historyRead: vi.fn() } }))
vi.mock('@/kcoder/gatewayMigration', () => ({ createMigrationApi: () => api }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const props = { deviceId: 'target', isCurrent: () => true, onBusy: vi.fn() }
beforeEach(() => { vi.resetAllMocks(); api.historyJobs.mockResolvedValue({ jobs: [], nextCursor: null }) })

test('history selection shows one backend page and leaves oversized sources blocked', async () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ sourceHandle: `source-${index}`, title: `Conversation ${index}`, sourceSessionId: `session-${index}`, importIssues: index === 0 ? ['too_large'] : [] }))
  api.historyDiscover.mockResolvedValue({ catalogId: 'catalog', items: rows, totalItems: 12, nextCursor: 'page-2', discoveryComplete: false })
  api.historySources.mockResolvedValue({ catalogId: 'catalog', items: [], totalItems: 12, nextCursor: null, discoveryComplete: true })
  render(<MigrationHistoryWorkspace {...props} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'history.discover' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'history.discover' }))
  await screen.findByText('Conversation 9')
  expect(screen.getAllByRole('button', { name: 'history.import' })).toHaveLength(10)
  expect(screen.getAllByRole('button', { name: 'history.import' })[0]).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'next' }))
  await waitFor(() => expect(api.historySources).toHaveBeenCalledWith({ catalogId: 'catalog', cursor: 'page-2' }))
})

test('an older target shows the upgrade message before exposing archive actions', async () => {
  api.historyJobs.mockRejectedValue(new Error('migration_update_required'))
  render(<MigrationHistoryWorkspace {...props} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('errors.migration_update_required')
  expect(screen.queryByRole('button', { name: 'history.discover' })).not.toBeInTheDocument()
  expect(api.historyDiscover).not.toHaveBeenCalled()
})
