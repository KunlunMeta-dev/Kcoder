import { budgetIndexedDbFixture } from '../../../../shared/migrationResourceBudgetIndexedDbFixture.mjs'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OwnedHistoryBudgetPanel } from './MigrationHistoryResourceBudgetPanel'
const { api } = vi.hoisted(() => ({ api: { historyResourcesRead: vi.fn(), historyResourcesIncrease: vi.fn() } }))
vi.mock('@/kcoder/gatewayMigration', () => ({ createMigrationApi: () => api }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const jobId = '4c6d9ee9-d145-4da4-ac73-35c2dce251ea'
const limits = { maxTotalBytes: 4194304, maxPayloadFiles: 16, minFreeBytes: 1048576, minFreeFileNodes: 0 }
const result = (ownerJobId = jobId) => ({ ownerJobId, initialLimits: limits, budget: { phase: 'active', jobId, limits, policyRevision: 0, usage: { committedBytes: 0, reservedBytes: 0, committedFiles: 0, reservedFiles: 0 } } })
const props = { jobId, deviceId: 'owned', workspacePath: '/owned', scope: 'account-target', isCurrent: () => true, cancelled: false }
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); vi.stubGlobal('indexedDB', budgetIndexedDbFixture().indexedDB); api.historyResourcesRead.mockResolvedValue(result()) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
async function edit() {
  await screen.findByTestId('migration-history-resource-bytes')
  fireEvent.change(screen.getByTestId('migration-history-resource-bytes'), { target: { value: '8388608' } })
  fireEvent.change(screen.getByTestId('migration-history-resource-files'), { target: { value: '16' } })
  fireEvent.click(screen.getByTestId('migration-history-resource-increase'))
  fireEvent.change(screen.getByTestId('migration-history-resource-word'), { target: { value: 'INCREASE' } })
}
it('reads only on mount and a cancelled original job invalidates a pending confirmation before dispatch', async () => {
  const rendered = render(<OwnedHistoryBudgetPanel {...props}/>)
  await edit(); expect(api.historyResourcesIncrease).not.toHaveBeenCalled()
  rendered.rerender(<OwnedHistoryBudgetPanel {...props} cancelled/>)
  expect(screen.getByTestId('migration-history-resource-confirm')).toBeDisabled()
  fireEvent.click(screen.getByTestId('migration-history-resource-confirm'))
  expect(api.historyResourcesIncrease).not.toHaveBeenCalled()
})
it('a lost reply survives a new view as a read-only original selector without starting or resuming work', async () => {
  api.historyResourcesIncrease.mockRejectedValue(new Error('lost reply'))
  const rendered = render(<OwnedHistoryBudgetPanel {...props}/>); await edit()
  fireEvent.click(screen.getByTestId('migration-history-resource-confirm')); await screen.findByRole('alert')
  const original = structuredClone(api.historyResourcesIncrease.mock.calls[0][0]); rendered.unmount()
  render(<OwnedHistoryBudgetPanel {...props}/>); await waitFor(() => expect(screen.getByTestId('migration-history-resource-resubmit')).not.toBeDisabled())
  expect(api.historyResourcesIncrease).toHaveBeenCalledTimes(1)
  expect(api.historyResourcesRead).toHaveBeenLastCalledWith({ jobId, requestId: original.requestId }, expect.anything())
  fireEvent.click(screen.getByTestId('migration-history-resource-resubmit'))
  fireEvent.change(screen.getByTestId('migration-history-resource-word'), { target: { value: 'INCREASE' } })
  fireEvent.click(screen.getByTestId('migration-history-resource-confirm'))
  await waitFor(() => expect(api.historyResourcesIncrease).toHaveBeenCalledTimes(2))
  expect(api.historyResourcesIncrease.mock.calls[1][0]).toEqual(original)
  expect(original).not.toHaveProperty('planId')
})
it('parent ownership is visible and does not offer a child increase', async () => {
  api.historyResourcesRead.mockResolvedValue(result('mig-parent'))
  render(<OwnedHistoryBudgetPanel {...props}/>); await screen.findByText('parentOwner')
  expect(screen.queryByTestId('migration-history-resource-increase')).toBeNull()
  expect(api.historyResourcesIncrease).not.toHaveBeenCalled()
})
