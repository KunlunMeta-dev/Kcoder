import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { MigrationHistoryWorkspace } from './MigrationHistoryWorkspace'
const { model } = vi.hoisted(() => ({
  model: {
    active: {
      job: {
        jobId: 'owned',
        stage: 'normalized',
        source: 'codex',
        sequence: 20,
        archived: true,
        normalization: { normalizedRecords: 20, sourceRecords: 100, recordsWithDiagnostics: 0 },
        failureCode: 'history_projection_recovery_required',
        cancelRequested: false,
      },
      workerRunning: false,
      workerState: undefined as undefined | 'running' | 'stopped' | 'unknown',
      workerError: null as string | null,
      progress: null,
    },
    busy: false,
    error: '',
    listJobs: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    open: vi.fn(),
    back: vi.fn(),
  },
}))
vi.mock('@/kcoder/useMigrationHistory', () => ({ useMigrationHistory: () => model }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./MigrationTranscriptViewer', () => ({
  MigrationTranscriptViewer: () => <div data-testid="blocked-projection" />,
}))
beforeEach(() => {
  vi.clearAllMocks()
  model.active.job.stage = 'normalized'
  model.active.job.failureCode = 'history_projection_recovery_required'
  model.active.workerRunning = false
  model.active.workerState = undefined
  model.active.workerError = null
})
test('an interrupted normalized index exposes explicit recovery and preserves the confirmed record count', () => {
  render(<MigrationHistoryWorkspace deviceId="target" isCurrent={() => true} onBusy={() => {}} />)
  expect(screen.getByRole('alert')).toHaveTextContent('errors.history_projection_recovery_required')
  expect(screen.queryByText('history.normalized_boundary')).not.toBeInTheDocument()
  expect(screen.queryByTestId('blocked-projection')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'history.recover' }))
  expect(model.resume).toHaveBeenCalledOnce()
})

test('a legacy checkpoint stays unconfirmed until a real worker is observed', () => {
  model.active.job.stage = 'normalizing'
  model.active.job.failureCode = ''
  const props = { deviceId: 'target', isCurrent: () => true, onBusy: () => {} }
  const view = render(<MigrationHistoryWorkspace {...props} />)
  expect(screen.getByRole('status')).toHaveTextContent('history.observing')
  expect(screen.queryByText('history.stages.normalizing')).not.toBeInTheDocument()
  expect(model.resume).not.toHaveBeenCalled()
  model.active.workerRunning = true
  view.rerender(<MigrationHistoryWorkspace {...props} />)
  expect(screen.getByRole('status')).toHaveTextContent('history.stages.normalizing')
  expect(screen.queryByText('history.observing')).not.toBeInTheDocument()
  expect(model.resume).not.toHaveBeenCalled()
})

test('unknown execution ownership disables control without claiming that a worker stopped', () => {
  model.active.job.stage = 'normalizing'
  model.active.job.failureCode = ''
  model.active.workerState = 'unknown'
  render(<MigrationHistoryWorkspace deviceId="target" isCurrent={() => true} onBusy={() => {}} />)
  expect(screen.getByRole('status')).toHaveTextContent('history.worker_unknown')
  expect(screen.getByRole('button', { name: 'history.run' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'history.run' }))
  expect(model.resume).not.toHaveBeenCalled()
})

test('an untracked normalized task offers ownership verification without requiring cancellation', () => {
  model.active.job.failureCode = ''
  model.active.workerState = 'unknown'
  model.active.workerError = 'history_job_execution_untracked'
  render(<MigrationHistoryWorkspace deviceId="target" isCurrent={() => true} onBusy={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'history.verify_owner' }))
  expect(model.resume).toHaveBeenCalledOnce()
  expect(model.cancel).not.toHaveBeenCalled()
})
