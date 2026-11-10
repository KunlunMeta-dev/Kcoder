import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useMigrationHistory } from './useMigrationHistory'

const { api } = vi.hoisted(() => ({ api: Object.fromEntries(
  ['historyDiscover', 'historySources', 'historyCreate', 'historyRead', 'historyRun', 'historyCancel', 'historyResume', 'historyJobs'].map(name => [name, vi.fn()])
) }))
vi.mock('./gatewayMigration', () => ({ createMigrationApi: () => api }))
const accepted = { job: { jobId: 'old-account-job', sequence: 0, source: 'claude-code', stage: 'capturing', archiveId: null, archived: false, normalization: null, failureCode: null, cancelRequested: false }, workerRunning: false, progress: null, workerError: null }
beforeEach(() => {
  vi.resetAllMocks()
  api.historyDiscover.mockResolvedValue({ catalogId: 'old-catalog', items: [], totalItems: 1, nextCursor: null, discoveryComplete: true, problems: [] })
  api.historyCreate.mockResolvedValue(accepted)
  api.historyRead.mockResolvedValue(accepted)
})

test('a lost create reply after account invalidation must not reconcile old identity in the replacement account', async () => {
  let reject!: (error: Error) => void
  let current = true
  api.historyCreate.mockReturnValue(new Promise((_, fail) => { reject = fail }))
  const { result } = renderHook(() => useMigrationHistory('same-target', '/owned', () => current))
  await act(() => result.current.discover())
  let pending!: Promise<boolean>
  act(() => { pending = result.current.importSource('selection') })
  await waitFor(() => expect(api.historyCreate).toHaveBeenCalledOnce())
  current = false
  await act(async () => { reject(new Error('migration_scope_changed')); await pending })
  expect(api.historyRead).not.toHaveBeenCalled()
  expect(api.historyRun).not.toHaveBeenCalled()
})

test('a lost run reply after account invalidation must not issue old-job reads in the replacement account', async () => {
  let reject!: (error: Error) => void
  let current = true
  api.historyRun.mockReturnValue(new Promise((_, fail) => { reject = fail }))
  const { result } = renderHook(() => useMigrationHistory('same-target', '/owned', () => current))
  await act(() => result.current.discover())
  let pending!: Promise<boolean>
  act(() => { pending = result.current.importSource('selection') })
  await waitFor(() => expect(api.historyRun).toHaveBeenCalledOnce())
  current = false
  await act(async () => { reject(new Error('migration_scope_changed')); await pending })
  expect(api.historyRead).not.toHaveBeenCalled()
  expect(api.historyRun).toHaveBeenCalledOnce()
})

test('a successful explicit refresh rearms observation after bounded catalog busy retries were exhausted', async () => {
  const live = { ...accepted, job: { ...accepted.job, sequence: 5, stage: 'normalizing' }, workerRunning: true }
  api.historyRun.mockResolvedValue(live)
  api.historyRead.mockRejectedValue(new Error('history_catalog_busy'))
  const { result } = renderHook(() => useMigrationHistory('same-target', '/owned', () => true))
  await act(() => result.current.discover())
  await act(() => result.current.importSource('selection'))
  await waitFor(() => expect(result.current.error).toBe('history_catalog_busy'), { timeout: 2200 })
  expect(api.historyRead).toHaveBeenCalledTimes(4)
  api.historyRead.mockResolvedValueOnce({ ...live, job: { ...live.job, sequence: 6 } })
    .mockResolvedValue({ ...live, job: { ...live.job, sequence: 7, stage: 'normalized' }, workerRunning: false })
  await act(() => result.current.open('old-account-job'))
  expect(result.current.error).toBe('')
  expect(result.current.active?.job.sequence).toBe(6)
  await waitFor(() => expect(result.current.active?.job.stage).toBe('normalized'), { timeout: 1600 })
  expect(api.historyRun).toHaveBeenCalledOnce()
})
