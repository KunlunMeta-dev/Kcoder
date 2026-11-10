import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { MigrationUploadCollectionPanel } from './MigrationUploadCollection'
const { model, hook } = vi.hoisted(() => {
  const model = {
    scope: {},
    result: {
      collection: {
        operationId: 'owned',
        collectionId: 'a'.repeat(64),
        sequence: 1,
        stage: 'prepared',
        cancelRequested: false,
        deletedBytes: 0,
        releasedReservationBytes: 0,
      },
      workerRunning: false,
      workerScheduled: false,
    },
    items: [],
    pages: [null],
    next: null,
    busy: false,
    error: '',
    prepare: vi.fn(),
    refresh: vi.fn(),
    run: vi.fn(),
    cancel: vi.fn(),
    choose: vi.fn(),
    previousPage: vi.fn(),
    nextPage: vi.fn(),
  }
  return { model, hook: vi.fn(() => model) }
})
vi.mock('@/kcoder/useMigrationUploadCollection', () => ({ useMigrationUploadCollection: hook }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const props = {
  context: { deviceId: 'target', jobId: 'history', isCurrent: () => true },
  position: 0,
  blockIndex: 1,
}
function expand() {
  const details = screen.getByTestId('migration-upload-collection') as HTMLDetailsElement
  details.open = true
  fireEvent(details, new Event('toggle'))
}
beforeEach(() => {
  vi.clearAllMocks()
  model.scope = {}
  model.error = ''
  model.result.workerScheduled = false
  model.result.workerRunning = false
  model.result.collection.stage = 'prepared'
  model.result.collection.cancelRequested = false
})
test('collapsed attachments do not scan collection storage, and expanding never prepares or runs', () => {
  render(<MigrationUploadCollectionPanel {...props} />)
  expect(hook).not.toHaveBeenCalled()
  expand()
  expect(hook).toHaveBeenCalled()
  expect(model.prepare).not.toHaveBeenCalled()
  expect(model.run).not.toHaveBeenCalled()
})
test('deletion requires its scoped keyword and explicit final confirmation', () => {
  render(<MigrationUploadCollectionPanel {...props} />)
  expand()
  fireEvent.click(screen.getByTestId('migration-collection-run'))
  expect(screen.getByTestId('migration-collection-confirm-submit')).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'COLLECT' } })
  fireEvent.click(screen.getByTestId('migration-collection-confirm-submit'))
  expect(model.run).toHaveBeenCalledWith(model.result.collection, 'run')
})
test('a confirmation from another target or selection cannot remain active', () => {
  const { rerender } = render(<MigrationUploadCollectionPanel {...props} />)
  expand()
  fireEvent.click(screen.getByTestId('migration-collection-run'))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'COLLECT' } })
  model.scope = {}
  rerender(
    <MigrationUploadCollectionPanel {...props} context={{ ...props.context, deviceId: 'other' }} />
  )
  expect(screen.queryByTestId('migration-collection-confirm-submit')).not.toBeInTheDocument()
  expect(model.run).not.toHaveBeenCalled()
})
test('accepted scheduling is distinct from Native execution and cancellation remains available', () => {
  model.result.workerScheduled = true
  render(<MigrationUploadCollectionPanel {...props} />)
  expand()
  expect(screen.getByText('upload_collection.scheduled')).toBeInTheDocument()
  expect(screen.queryByText('upload_collection.working')).not.toBeInTheDocument()
  expect(screen.queryByTestId('migration-collection-run')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('migration-collection-cancel'))
  expect(model.cancel).toHaveBeenCalledOnce()
})
