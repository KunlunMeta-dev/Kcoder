import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { MigrationLocalAttachment } from './MigrationLocalAttachment'

const { model } = vi.hoisted(() => ({ model: {
  state: { workerRunning: false, workerError: null, upload: {
    operationId: 'owned', stage: 'authorized', filename: 'selected.txt', bytes: 3,
    receivedBytes: 3, cancelRequested: true, failureCode: null,
    localJob: { state: { stage: 'cancelled', receipt: null, cancelRequested: true,
      processedBytes: 0, failureCode: null } },
  } }, items: [], nextCursor: null, busy: false, error: '', hashing: null,
  prepare: vi.fn(), resume: vi.fn(), run: vi.fn(), cancel: vi.fn(), refresh: vi.fn(),
  save: vi.fn(), open: vi.fn(), listMore: vi.fn(), upload: vi.fn(), finalize: vi.fn(),
} }))
vi.mock('@/kcoder/useMigrationLocalAttachment', () => ({ useMigrationLocalAttachment: () => model }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
beforeEach(() => {
  vi.clearAllMocks()
  model.state.upload.cancelRequested = true
})

test('an authorized copy cancelled before run has an explicit resume action, then a separate copy action', () => {
  const props = { context: { deviceId: 'target', jobId: 'history', isCurrent: () => true }, position: 0, blockIndex: 1 }
  const { rerender } = render(<MigrationLocalAttachment {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'local_attachment.resume' }))
  expect(model.resume).toHaveBeenCalledOnce()
  expect(model.run).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'local_attachment.store' })).not.toBeInTheDocument()
  model.state.upload.cancelRequested = false
  rerender(<MigrationLocalAttachment {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'local_attachment.store' }))
  expect(model.run).toHaveBeenCalledOnce()
})
