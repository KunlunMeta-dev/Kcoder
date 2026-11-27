import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useMigrationHistory } from './useMigrationHistory'

const { api } = vi.hoisted(() => ({ api: Object.fromEntries([
  'historyRead', 'historyRun', 'historyReinterpretPreview', 'historyReinterpretCreate',
].map(name => [name, vi.fn()])) }))
vi.mock('./gatewayMigration', () => ({ createMigrationApi: () => api }))

const source = {
  job: { jobId: 'old-job', sequence: 9, source: 'codex', stage: 'normalized', archiveId: 'archive',
    archived: true, normalization: null, failureCode: null, cancelRequested: false },
  workerRunning: false, progress: null, workerError: null,
}
const preview = { sourceJobId: 'old-job', sourceSequence: 9, sourceRevision: 'foreign-records/3',
  parserRevision: 'foreign-records/4', canCreate: true, reasonCode: null }
const newRecord = (id: string) => ({ ...source, job: { ...source.job, jobId: id, sequence: 0, stage: 'normalizing' } })

beforeEach(() => {
  vi.resetAllMocks()
  api.historyRead.mockResolvedValue(source)
  api.historyReinterpretPreview.mockResolvedValue(preview)
  api.historyReinterpretCreate.mockImplementation(async ({ requestId }) => newRecord(requestId))
  api.historyRun.mockImplementation(async ({ jobId }) => ({ ...newRecord(jobId), job: { ...newRecord(jobId).job, sequence: 1 }, workerRunning: false }))
})

test('read-only inspection preserves the old interpretation until explicit confirmation', async () => {
  const { result } = renderHook(() => useMigrationHistory('target', '/owned', () => true))
  await act(() => result.current.open('old-job'))
  await act(() => result.current.prepareReinterpretation())
  expect(api.historyReinterpretCreate).not.toHaveBeenCalled()
  expect(api.historyRun).not.toHaveBeenCalled()
  expect(result.current.active).toEqual(source)
  expect(result.current.reinterpretation).toEqual(preview)
  await act(() => result.current.reinterpret())
  const params = api.historyReinterpretCreate.mock.calls[0][0]
  expect(params).toEqual({ requestId: expect.any(String), sourceJobId: 'old-job', expectedSourceSequence: 9 })
  expect(params.requestId).toMatch(/^[a-f0-9-]{36}$/)
  expect(api.historyRun).toHaveBeenCalledExactlyOnceWith({ jobId: params.requestId, expectedSequence: 0 })
  expect(result.current.active?.job.jobId).toBe(params.requestId)
  expect(result.current.reinterpretation).toBeNull()
  expect(source.job.jobId).toBe('old-job')
})

test('a missing creation receipt permits only same-identity observation, never an automatic run', async () => {
  api.historyReinterpretCreate.mockRejectedValue(new Error('connection_lost'))
  const { result } = renderHook(() => useMigrationHistory('target', '/owned', () => true))
  await act(() => result.current.open('old-job'))
  await act(() => result.current.prepareReinterpretation())
  api.historyRead.mockImplementation(async id => newRecord(id))
  await act(() => result.current.reinterpret())
  const { requestId } = api.historyReinterpretCreate.mock.calls[0][0]
  expect(api.historyRead).toHaveBeenLastCalledWith(requestId)
  expect(result.current.active?.job.jobId).toBe(requestId)
  expect(api.historyRun).not.toHaveBeenCalled()
  expect(api.historyReinterpretCreate).toHaveBeenCalledTimes(1)
  await act(() => result.current.resume())
  expect(api.historyRun).toHaveBeenCalledExactlyOnceWith({ jobId: requestId, expectedSequence: 0 })
})

test('an invalidated scope cannot reconcile or run a late creation failure', async () => {
  let current = true
  let reject!: (cause: Error) => void
  api.historyReinterpretCreate.mockImplementation(() => new Promise((_, fail) => { reject = fail }))
  const { result } = renderHook(() => useMigrationHistory('target', '/owned', () => current))
  await act(() => result.current.open('old-job'))
  await act(() => result.current.prepareReinterpretation())
  let pending!: Promise<boolean>
  act(() => { pending = result.current.reinterpret() })
  current = false
  await act(async () => { reject(new Error('connection_lost')); await pending })
  expect(api.historyRead).toHaveBeenCalledTimes(1)
  expect(api.historyRun).not.toHaveBeenCalled()
  expect(result.current.active?.job.jobId).toBe('old-job')
})

test('a newer source checkpoint invalidates the confirmation and never creates a new job', async () => {
  const { result } = renderHook(() => useMigrationHistory('target', '/owned', () => true))
  await act(() => result.current.open('old-job'))
  await act(() => result.current.prepareReinterpretation())
  api.historyRead.mockResolvedValue({ ...source, job: { ...source.job, sequence: 10 } })
  await act(() => result.current.open('old-job'))
  expect(result.current.reinterpretation).toBeNull()
  await act(() => result.current.reinterpret())
  expect(api.historyReinterpretCreate).not.toHaveBeenCalled()
})

test('a forged creation result never changes the selected job or starts a worker', async () => {
  api.historyReinterpretCreate.mockResolvedValue(newRecord('other-job'))
  const { result } = renderHook(() => useMigrationHistory('target', '/owned', () => true))
  await act(() => result.current.open('old-job'))
  await act(() => result.current.prepareReinterpretation())
  await act(() => result.current.reinterpret())
  expect(result.current.error).toBe('migration_invalid_result')
  expect(result.current.active?.job.jobId).toBe('old-job')
  expect(api.historyRun).not.toHaveBeenCalled()
})
