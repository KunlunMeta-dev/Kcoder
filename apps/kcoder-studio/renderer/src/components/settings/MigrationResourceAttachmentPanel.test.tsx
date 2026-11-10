import { budgetIndexedDbFixture } from '../../../../shared/migrationResourceBudgetIndexedDbFixture.mjs'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MigrationResourceAttachmentPanel } from './MigrationResourceAttachmentPanel'
const { api } = vi.hoisted(() => ({ api: { historyResourceAttachmentRead: vi.fn(), batchResourceAttachmentRead: vi.fn(), historyResourcesAttach: vi.fn(), batchResourcesAttach: vi.fn() } }))
vi.mock('@/kcoder/gatewayMigration', () => ({ createMigrationApi: () => api }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const limits = { maxTotalBytes: 4194304, maxPayloadFiles: 16, minFreeBytes: 1048576, minFreeFileNodes: 0 }
const pending = { jobId: 'mig-owned', ownerJobId: 'mig-owned', currentSequence: 9, currentPlanId: 'plan-owned', phase: 'pending', originalIntent: { expectedSequence: 2, planId: 'plan-owned', initialLimits: limits }, issueCode: null }
const props = { deviceId: 'owned', workspacePath: '/owned', scope: 'account-target', kind: 'batch' as const, jobId: 'mig-owned', isCurrent: () => true }
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); vi.stubGlobal('indexedDB', budgetIndexedDbFixture().indexedDB); api.batchResourceAttachmentRead.mockResolvedValue(pending) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('recovers the original intent with no local cache and writes only after BIND using the old sequence', async () => {
  api.batchResourcesAttach.mockResolvedValue({})
  render(<MigrationResourceAttachmentPanel {...props}/>); await screen.findByTestId('migration-attachment-original')
  expect(api.batchResourcesAttach).not.toHaveBeenCalled(); fireEvent.click(screen.getByTestId('migration-attachment-resume'))
  expect(screen.getByTestId('migration-attachment-confirm')).toBeDisabled()
  fireEvent.change(screen.getByTestId('migration-attachment-word'), { target: { value: 'BIND' } }); fireEvent.click(screen.getByTestId('migration-attachment-confirm'))
  await waitFor(() => expect(api.batchResourcesAttach).toHaveBeenCalledTimes(1))
  expect(api.batchResourcesAttach).toHaveBeenCalledWith({ jobId: 'mig-owned', planId: 'plan-owned', expectedSequence: 2, limits, confirm: true })
})
it('does not resubmit when a fresh observation is already attached, damaged or the account was revoked', async () => {
  for (const phase of ['attached', 'unknown']) {
    const rendered = render(<MigrationResourceAttachmentPanel {...props}/>); await screen.findByTestId('migration-attachment-resume')
    fireEvent.click(screen.getByTestId('migration-attachment-resume')); api.batchResourceAttachmentRead.mockResolvedValueOnce({ ...pending, phase, issueCode: phase === 'unknown' ? 'history_resource_ledger_missing' : null })
    fireEvent.change(screen.getByTestId('migration-attachment-word'), { target: { value: 'BIND' } }); fireEvent.click(screen.getByTestId('migration-attachment-confirm'))
    await screen.findByRole('alert'); expect(api.batchResourcesAttach).not.toHaveBeenCalled(); rendered.unmount()
  }
})
