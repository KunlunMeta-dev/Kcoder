import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { MigrationHistoryAttachment } from './MigrationHistoryAttachment'
const { model } = vi.hoisted(() => ({
  model: {
    result: {
      job: null as null | {
        stage: string
        processedBytes: number
        info: { displayName: string; receipt?: { bytes: number } } | null
        failureCode: null
        cancelRequested: boolean
      },
      workerRunning: false,
      workerError: null,
    },
    busy: false,
    error: '',
    downloaded: null as number | null,
    run: vi.fn(),
    cancel: vi.fn(),
    refresh: vi.fn(),
    save: vi.fn(),
    cancelDownload: vi.fn(),
  },
}))
vi.mock('@/kcoder/useMigrationAttachment', () => ({ useMigrationAttachment: () => model }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
beforeEach(() => {
  model.result = { job: null, workerRunning: false, workerError: null }
  model.downloaded = null
  vi.clearAllMocks()
})
const props = {
  context: { deviceId: 'target', jobId: 'job', isCurrent: () => true },
  position: 0,
  blockIndex: 1,
}
test('the historical attachment has an explicit extraction action and a later download action', () => {
  const { rerender } = render(<MigrationHistoryAttachment {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'attachment.run' }))
  expect(model.run).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: 'attachment.download' })).not.toBeInTheDocument()
  model.result.job = {
    stage: 'ready',
    processedBytes: 4,
    info: { displayName: 'report.txt' },
    failureCode: null,
    cancelRequested: false,
  }
  rerender(<MigrationHistoryAttachment {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'attachment.download' }))
  expect(model.save).toHaveBeenCalledOnce()
})
test('an owned download has a distinct cancel action without cancelling extraction', () => {
  model.result.job = {
    stage: 'ready',
    processedBytes: 4,
    info: { displayName: 'report.txt' },
    failureCode: null,
    cancelRequested: false,
  }
  model.downloaded = 2
  render(<MigrationHistoryAttachment {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'attachment.cancel_download' }))
  expect(model.cancelDownload).toHaveBeenCalledOnce()
  expect(model.cancel).not.toHaveBeenCalled()
})

test('the native save handoff does not offer a transfer cancel that can no longer stop the save', () => {
  model.result.job = {
    stage: 'ready',
    processedBytes: 4,
    info: { displayName: 'report.txt', receipt: { bytes: 4 } },
    failureCode: null,
    cancelRequested: false,
  }
  model.downloaded = 4
  render(<MigrationHistoryAttachment {...props} />)
  expect(screen.getByText('attachment.saving_local')).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'attachment.cancel_download' })
  ).not.toBeInTheDocument()
})
