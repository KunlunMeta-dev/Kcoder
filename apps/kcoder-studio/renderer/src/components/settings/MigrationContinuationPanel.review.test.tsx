import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { MigrationContinuationPanel } from './MigrationContinuationPanel'

const { continuation, undo, navigate, refresh } = vi.hoisted(() => ({
  continuation: { result: null as unknown, busy: false, error: '', create: vi.fn(), resume: vi.fn(), cancel: vi.fn(), refresh: vi.fn() },
  undo: { ready: true, busy: false, unsupported: false, error: '', preview: null, result: null as unknown, prepare: vi.fn(), start: vi.fn(), cancel: vi.fn(), refresh: vi.fn() },
  navigate: vi.fn(), refresh: vi.fn(),
}))
vi.mock('@/kcoder/useMigrationContinuation', () => ({ useMigrationContinuation: () => continuation }))
vi.mock('@/kcoder/useMigrationUndo', () => ({ useMigrationUndo: () => undo }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => ({ openRuntimeTask: navigate, refreshWorkLists: refresh }) }))

const props = { deviceId: 'owned-target', workspacePath: '/owned', sourceJobId: 'archive-job', viewId: 'branch-a', isCurrent: () => true }
beforeEach(() => {
  vi.clearAllMocks()
  refresh.mockResolvedValue(undefined)
  continuation.result = { job: { jobId: 'continuation-a', sequence: 7, stage: 'imported', threadId: 'ThreadA', compilation: null, projection: null }, workerRunning: false }
  undo.result = null
})

test('a confirmed undo received while open is waiting must prevent navigation to the removed session', async () => {
  let finish!: () => void
  refresh.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  const view = render(<MigrationContinuationPanel {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'continuation.open' }))
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  undo.result = { job: { jobId: 'undo-a', stage: 'undone', checkedBytes: 10, cancelRequested: false, failureCode: null }, workerRunning: false, workerError: null }
  view.rerender(<MigrationContinuationPanel {...props} />)
  expect(screen.getByRole('button', { name: /^continuation\.(open|opening)$/ })).toBeDisabled()
  await act(async () => { finish(); await Promise.resolve() })
  expect(navigate).not.toHaveBeenCalled()
})

test('leaving the selected source while open is waiting revokes the old navigation lifetime', async () => {
  let finish!: () => void
  refresh.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  const view = render(<MigrationContinuationPanel {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'continuation.open' }))
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  // Target/account remain valid: only this selected archive/branch panel is gone.
  view.unmount()
  await act(async () => { finish(); await Promise.resolve() })
  expect(navigate).not.toHaveBeenCalled()
})

test('an active undo worker blocks session activation after its launch request has returned', () => {
  undo.result = { job: { jobId: 'undo-a', stage: 'checking', checkedBytes: 10, cancelRequested: false, failureCode: null }, workerRunning: true, workerError: null }
  // Request busy has ended, but the server-owned destructive worker has not.
  expect(undo.busy).toBe(false)
  render(<MigrationContinuationPanel {...props} />)
  expect(screen.getByRole('button', { name: 'continuation.open' })).toBeDisabled()
  expect(navigate).not.toHaveBeenCalled()
})
