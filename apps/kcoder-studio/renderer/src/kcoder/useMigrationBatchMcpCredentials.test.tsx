import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useMigrationBatchMcpCredentials } from './useMigrationBatchMcpCredentials'
import type {
  MigrationJobReadResult,
  MigrationMcpCredentialsResult,
} from '../../../shared/generated/contracts'

const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./gatewayMigration', () => ({
  createMigrationApi: () => ({ readBatchMcpCredentials: read }),
}))
const job = {
  source: 'codex',
  plans: [],
  issues: [],
  job: {
    jobId: 'owned-job',
    sourceId: 'source',
    sequence: 5,
    status: 'ready',
    totalItems: 1,
    committedItems: 0,
    requiresActionItems: 0,
  },
  batch: {
    planId: 'plan',
    selectedItems: 1,
    totalActions: 2,
    committedActions: 0,
    unresolvedActions: 2,
    defaultItemIds: [],
  },
} as MigrationJobReadResult
const resultFor = (sequence = 5): MigrationMcpCredentialsResult => ({
  job: { ...job.job, sequence },
  plans: [
    {
      planId: 'owned-key',
      itemId: 'mcp',
      targetName: 'docs',
      transport: 'stdio',
      storage: 'file',
      fields: [{ kind: 'environment', name: 'TOKEN' }],
      remainingFields: 1,
      phase: 'ready',
      undoRequested: false,
      errorCode: null,
    },
  ],
})
beforeEach(() => {
  vi.resetAllMocks()
  read.mockResolvedValue(resultFor())
})

test('reads only the selected job and releases its owned read when the view closes', async () => {
  const { result, rerender, unmount } = renderHook(
    ({ value }: { value: MigrationJobReadResult | null }) =>
      useMigrationBatchMcpCredentials('target', '/owned', value, () => true),
    { initialProps: { value: null } }
  )
  expect(read).not.toHaveBeenCalled()
  rerender({ value: job })
  await waitFor(() => expect(result.current.plans).toHaveLength(1))
  expect(read).toHaveBeenCalledWith(
    'owned-job',
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  )
  expect(result.current.supported).toBe(true)
  const signal = read.mock.calls[0][1].signal as AbortSignal
  unmount()
  expect(signal.aborted).toBe(true)
})

test('older read responses cannot replace a newer sequence or a replacement target', async () => {
  let finish!: (value: MigrationMcpCredentialsResult) => void
  read.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const { result, rerender } = renderHook(
    ({ target, value }) => useMigrationBatchMcpCredentials(target, '/owned', value, () => true),
    {
      initialProps: { target: 'first', value: job },
    }
  )
  await waitFor(() => expect(read).toHaveBeenCalledOnce())
  const signal = read.mock.calls[0][1].signal as AbortSignal
  read.mockResolvedValue(resultFor(6))
  rerender({ target: 'second', value: { ...job, job: { ...job.job, sequence: 6 } } })
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(signal.aborted).toBe(true)
  await act(async () => {
    finish({ ...resultFor(), plans: [] })
  })
  expect(result.current.plans).toHaveLength(1)
  expect(read).toHaveBeenCalledTimes(2)
})

test('legacy unsupported targets retain ordinary batches and a failed read requires explicit refresh', async () => {
  read.mockRejectedValueOnce(new Error('migration_update_required'))
  const { result } = renderHook(() =>
    useMigrationBatchMcpCredentials('target', '/owned', job, () => true)
  )
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.supported).toBe(false)
  expect(result.current.error).toBe('')
  read.mockRejectedValueOnce(new Error('transport interrupted'))
  act(() => result.current.refresh())
  await waitFor(() => expect(result.current.error).toBe('error'))
  expect(read).toHaveBeenCalledTimes(2)
  act(() => result.current.refresh())
  await waitFor(() => expect(result.current.plans).toHaveLength(1))
  expect(result.current.error).toBe('')
  expect(read).toHaveBeenCalledTimes(3)
})

test('wrong jobs and stale checkpoints are rejected and a replaced account cannot accept a late response', async () => {
  read.mockResolvedValueOnce({ ...resultFor(), job: { ...job.job, jobId: 'other' } })
  let current = true
  const { result } = renderHook(() =>
    useMigrationBatchMcpCredentials('target', '/owned', job, () => current)
  )
  await waitFor(() => expect(result.current.error).toBe('migration_stale_cursor'))
  read.mockResolvedValueOnce(resultFor(4))
  act(() => result.current.refresh())
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.plans).toEqual([])
  let finish!: (value: MigrationMcpCredentialsResult) => void
  read.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  act(() => result.current.refresh())
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3))
  current = false
  await act(async () => {
    finish(resultFor())
  })
  expect(result.current.plans).toEqual([])
})
