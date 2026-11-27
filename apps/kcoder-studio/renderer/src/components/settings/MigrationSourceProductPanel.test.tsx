import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MigrationSourceProductPanel } from './MigrationSourceProductPanel'
import type { SourceUploadState } from '../../../../shared/generated/contracts'
const api = vi.hoisted(() => ({ sourceProductRun: vi.fn(), sourceProductRead: vi.fn(), sourceProductCancel: vi.fn(), sourceProductResume: vi.fn() }))
vi.mock('@/kcoder/gatewayMigration', () => ({ createMigrationApi: () => api }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const current = () => true, target = { id: 'owned', label: 'Owned', runtime: 'kcoder' as const, transport: 'local' as const, description: '' }
const upload: SourceUploadState = { operationId: '11111111-1111-4111-8111-111111111111', manifestSha256: 'a'.repeat(64), source: 'codex', totalFiles: 1, totalBytes: 4, receivedBytes: 4, verifiedBytes: 4, completedFiles: 1,
  sequence: 999, cancelWatermark: 888, cancelRequested: false, stage: 'ready', workerState: 'stopped' }
const product = (patch: Partial<SourceUploadState> = {}) => ({ materialization: { ...upload, sequence: 0, cancelWatermark: 0, verifiedBytes: 0, completedFiles: 0, stage: 'verifying', ...patch } })
beforeEach(() => { vi.clearAllMocks(); localStorage.clear() })
it('does not prepare from upload Ready automatically and enables inspection only after independent product Ready', async () => {
  const inspect = vi.fn()
  api.sourceProductRun.mockResolvedValue(product({ workerState: 'running' }))
  api.sourceProductRead.mockResolvedValue(product({ stage: 'ready', sequence: 4, verifiedBytes: 4, completedFiles: 1 }))
  render(<MigrationSourceProductPanel target={target} upload={upload} isCurrent={current} onBusy={vi.fn()} onInspect={inspect}/>)
  expect(api.sourceProductRun).not.toHaveBeenCalled()
  expect(screen.queryByText('product.inspect')).toBeNull()
  fireEvent.click(screen.getByText('product.start'))
  await screen.findByText('product.stages.verifying')
  expect(api.sourceProductRun.mock.calls[0][0]).toMatchObject({ expectedSequence: 0, cancelWatermark: 0 })
  expect(screen.queryByText('product.inspect')).toBeNull()
  fireEvent.click(screen.getByText('product.read')); await screen.findByText('product.stages.ready')
  expect(inspect).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('product.inspect'))
  expect(inspect).toHaveBeenCalledWith(product({ stage: 'ready', sequence: 4, verifiedBytes: 4, completedFiles: 1 }).materialization)
})
it('offers cancel while a product run reply is pending and never applies that late run state', async () => {
  let finish!: (value: unknown) => void
  api.sourceProductRun.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  api.sourceProductCancel.mockResolvedValue(product({ stage: 'cancelled', sequence: 1, cancelWatermark: 1, cancelRequested: true }))
  render(<MigrationSourceProductPanel target={target} upload={upload} isCurrent={current} onBusy={vi.fn()} onInspect={vi.fn()}/>)
  fireEvent.click(screen.getByText('product.start'))
  expect(await screen.findByText('product.cancel')).not.toBeDisabled()
  fireEvent.click(screen.getByText('product.cancel')); await screen.findByText('product.stages.cancelled')
  await act(async () => finish(product({ stage: 'ready', verifiedBytes: 4, completedFiles: 1 })))
  expect(screen.getByText('product.stages.cancelled')).toBeTruthy()
  expect(screen.queryByText('product.inspect')).toBeNull()
})
