import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { MigrationUndoPanel } from './MigrationUndoPanel'
import type { useMigrationUndo } from '@/kcoder/useMigrationUndo'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const model = {
  ready: true,
  busy: false,
  error: '',
  unsupported: false,
  preview: null as unknown,
  result: null as unknown,
  prepare: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  refresh: vi.fn(),
}
beforeEach(() => {
  vi.clearAllMocks()
  model.preview = null
  model.result = null
  model.error = ''
  model.busy = false
})
const show = () =>
  render(<MigrationUndoPanel model={model as unknown as ReturnType<typeof useMigrationUndo>} />)
test('eligibility and final confirmation are explicit and do not run on mount', () => {
  const view = show()
  expect(model.prepare).not.toHaveBeenCalled()
  expect(model.start).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'undo.prepare' }))
  expect(model.prepare).toHaveBeenCalledOnce()
  expect(model.start).not.toHaveBeenCalled()
  model.preview = { canUndo: true }
  view.rerender(
    <MigrationUndoPanel model={model as unknown as ReturnType<typeof useMigrationUndo>} />
  )
  fireEvent.click(screen.getByRole('button', { name: 'undo.confirm' }))
  expect(model.start).toHaveBeenCalledOnce()
})
test('unknown outcome offers reconciliation and is never presented as cancelled', () => {
  model.result = {
    job: { stage: 'outcome_unknown', checkedBytes: 42, cancelRequested: true, failureCode: null },
    workerRunning: false,
    workerError: null,
  }
  show()
  expect(screen.getByRole('status')).toHaveTextContent('undo.stages.outcome_unknown')
  expect(screen.queryByText('undo.stages.cancelled')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'undo.reconcile' }))
  expect(model.start).toHaveBeenCalledOnce()
})
test('confirmed undo has no repeat action and keeps retained-source copy visible', () => {
  model.result = {
    job: { stage: 'undone', checkedBytes: 42, cancelRequested: false, failureCode: null },
    workerRunning: false,
    workerError: null,
  }
  show()
  expect(screen.getByRole('status')).toHaveTextContent('undo.stages.undone')
  expect(screen.getByText('undo.boundary')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'undo.prepare' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'undo.reconcile' })).not.toBeInTheDocument()
})
