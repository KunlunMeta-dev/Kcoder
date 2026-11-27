import { Blob as NodeBlob } from 'node:buffer'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MigrationSourceUploadPanel } from './MigrationSourceUploadPanel'
const api = vi.hoisted(() => ({ sourceUploadPrepare: vi.fn(), sourceUploadRead: vi.fn(), sourceUploadFiles: vi.fn(), sourceUploadPart: vi.fn(), sourceUploadFinish: vi.fn(), sourceUploadCancel: vi.fn(), sourceUploadResume: vi.fn() }))
vi.mock('@/kcoder/gatewayMigration', () => ({ createMigrationApi: () => api }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const target = { id: 'owned', label: 'Owned', description: '', runtime: 'kcoder' as const, transport: 'local' as const }
function blob() { const file = new NodeBlob(['body']); Object.defineProperty(file, 'name', { value: 'config.toml' }); return file as unknown as File }
beforeEach(() => { vi.clearAllMocks(); localStorage.clear() })
it('requires explicit selection/upload and shows Ready as received bytes until the separate use action', async () => {
  let id = '', sha = ''
  const state = () => ({ upload: { operationId: id, manifestSha256: sha, source: 'codex', totalFiles: 1, totalBytes: 4, receivedBytes: 4, completedFiles: 1, verifiedBytes: 4, sequence: 0, cancelWatermark: 0, cancelRequested: false, workerState: 'stopped', stage: 'ready' } })
  api.sourceUploadPrepare.mockImplementation(async input => {
    id = input.operationId
    const key = Object.keys(localStorage).find(key => key.startsWith('kcoder.migration.source-upload:') && key.endsWith(`:${id}`))!
    sha = JSON.parse(localStorage.getItem(key)!).manifestSha256
    return { upload: { ...state().upload, stage: 'receiving', receivedBytes: 0, verifiedBytes: 0, completedFiles: 0 } }
  })
  api.sourceUploadFiles.mockImplementation(async () => ({ page: { operationId: id, manifestSha256: sha, files: [{ fileIndex: 0, acceptedBytes: 0, nextPart: 0, complete: false }], nextCursor: null } }))
  api.sourceUploadPart.mockImplementation(async () => ({ upload: { ...state().upload, stage: 'receiving', verifiedBytes: 0 } }))
  api.sourceUploadFinish.mockImplementation(async () => state())
  const use = vi.fn()
  render(<MigrationSourceUploadPanel target={target} isCurrent={() => true} onBusy={vi.fn()} onUse={use}/>)
  expect(api.sourceUploadPrepare).not.toHaveBeenCalled()
  expect(screen.getByText('start')).toBeDisabled()
  fireEvent.change(screen.getByTestId('source-upload-product'), { target: { value: 'codex' } })
  await act(async () => fireEvent.change(screen.getByTestId('source-upload-input'), { target: { files: [blob()] } }))
  await waitFor(() => expect(screen.getByText('start')).not.toBeDisabled())
  expect(api.sourceUploadPrepare).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('start')); await screen.findByText('readyBoundary')
  expect(api.sourceUploadPrepare).toHaveBeenCalledOnce()
  expect(use).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('useReady'))
  expect(use).toHaveBeenCalledWith(state().upload)
})
it('closing an owned panel during hashing stops local work without creating an upload or peer cleanup', async () => {
  let finish!: (value: ArrayBuffer) => void
  const file = { name: 'config.toml', size: 8, slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { finish = resolve }) }) } as File
  const view = render(<MigrationSourceUploadPanel target={target} isCurrent={() => true} onBusy={vi.fn()} onUse={vi.fn()}/>)
  fireEvent.change(screen.getByTestId('source-upload-product'), { target: { value: 'codex' } })
  fireEvent.change(screen.getByTestId('source-upload-input'), { target: { files: [file] } })
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  view.unmount(); await act(async () => finish(new ArrayBuffer(8)))
  expect(api.sourceUploadPrepare).not.toHaveBeenCalled()
  expect(api.sourceUploadCancel).not.toHaveBeenCalled()
})
it('shows excluded directory counts and hashes only retained files before any upload', async () => {
  const readPrivate = vi.fn(() => { throw new Error('AUTH_CANARY_MUST_NOT_BE_READ') })
  const allowed = blob(); Object.defineProperty(allowed, 'webkitRelativePath', { value: '.codex/config.toml' })
  const privateFile = { name: 'auth.json', webkitRelativePath: '.codex/auth.json', get size() { return readPrivate() }, get slice() { return readPrivate() } } as unknown as File
  const cached = { name: 'index', webkitRelativePath: '.codex/.git/index', get size() { return readPrivate() }, get slice() { return readPrivate() } } as unknown as File
  render(<MigrationSourceUploadPanel target={target} isCurrent={() => true} onBusy={vi.fn()}/>)
  fireEvent.change(screen.getByTestId('source-upload-product'), { target: { value: 'codex' } })
  fireEvent.change(screen.getByTestId('source-upload-mode'), { target: { value: 'directory' } })
  await act(async () => fireEvent.change(screen.getByTestId('source-upload-input'), { target: { files: [allowed, privateFile, cached] } }))
  await waitFor(() => expect(screen.getByText('start')).not.toBeDisabled())
  expect(screen.getByTestId('source-upload-exclusions')).toHaveTextContent('excludedPrivate')
  expect(screen.getByTestId('source-upload-exclusions')).toHaveTextContent('excludedCache')
  expect(readPrivate).not.toHaveBeenCalled()
  expect(api.sourceUploadPrepare).not.toHaveBeenCalled()
})
