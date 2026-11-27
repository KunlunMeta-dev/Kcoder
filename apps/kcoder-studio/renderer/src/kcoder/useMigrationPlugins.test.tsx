import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useMigrationPlugins } from './useMigrationPlugins'
import { notifyAccountContextChange } from './accountContextEvents'
import type { MigrationPluginStateResult } from '../../../shared/generated/contracts'
const { api } = vi.hoisted(() => ({
  api: Object.fromEntries(
    ['discover', 'list', 'read', 'plan', 'capture', 'apply', 'undo', 'cancel', 'resume'].map(
      name => [name, vi.fn()]
    )
  ),
}))
vi.mock('./gatewayMigrationPlugins', () => ({ createMigrationPluginsApi: () => api }))
function state(operationId = 'operation', changes: object = {}): MigrationPluginStateResult {
  return {
    job: {
      operationId,
      sequence: 1,
      stage: 'ready',
      source: 'claude-code',
      name: 'sample',
      installedVersion: '1.0.0',
      scope: 'user',
      sourceEnabled: true,
      targetId: 'sample@migrated-fixture',
      packageFiles: 2,
      packageBytes: 32,
      capabilities: ['skills'],
      readiness: [],
      pending: [],
      imported: false,
      cancelRequested: false,
      cancelRevision: 0,
      ...changes,
    },
    workerRunning: false,
    workerError: null,
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  api.list.mockResolvedValue({ items: [], nextCursor: null })
  api.read.mockImplementation(async (id: string) => state(id))
  api.plan.mockImplementation(async ({ requestId }: { requestId: string }) => state(requestId))
  api.discover.mockResolvedValue({ candidates: [], problems: [], nextCursor: null })
})
test('mount only lists target-owned records and never scans a source or starts work', async () => {
  const { result } = renderHook(() => useMigrationPlugins('target', '/owned', () => true))
  await waitFor(() => expect(result.current.records).not.toBeNull())
  expect(api.list).toHaveBeenCalledExactlyOnceWith(undefined, { signal: expect.any(AbortSignal) })
  for (const name of ['discover', 'read', 'plan', 'capture', 'apply', 'undo'])
    expect(api[name]).not.toHaveBeenCalled()
  expect(result.current.state).toBeNull()
})
test('a lost plan reply only reconciles the same operation and never repeats preparation or installation', async () => {
  api.plan.mockRejectedValue(new Error('transport lost'))
  const { result } = renderHook(() => useMigrationPlugins('target', '/owned', () => true))
  await waitFor(() => expect(result.current.records).not.toBeNull())
  await act(() => result.current.plan('candidate'))
  const id = api.plan.mock.calls[0][0].requestId
  expect(id).toMatch(/^[a-f0-9-]{36}$/)
  expect(api.read).toHaveBeenCalledWith(id, undefined)
  expect(result.current.state?.job.operationId).toBe(id)
  expect(api.apply).not.toHaveBeenCalled()
  await act(() => result.current.plan('candidate'))
  expect(api.plan).toHaveBeenCalledTimes(1)
  expect(api.read).toHaveBeenCalledTimes(2)
})
test('mutations first read the original operation and use its latest sequence', async () => {
  const { result } = renderHook(() => useMigrationPlugins('target', '/owned', () => true))
  await waitFor(() => expect(result.current.records).not.toBeNull())
  await act(() => result.current.open('operation'))
  api.read.mockResolvedValue(state('operation', { sequence: 9 }))
  api.apply.mockResolvedValue(
    state('operation', { sequence: 10, stage: 'imported', imported: true })
  )
  await act(() => result.current.apply())
  expect(api.apply).toHaveBeenCalledExactlyOnceWith({
    operationId: 'operation',
    expectedSequence: 9,
  })
  expect(result.current.state?.job.stage).toBe('imported')
})
test('account invalidation fences a late mutation and does not reconcile into the new account', async () => {
  let reject!: (error: Error) => void
  api.plan.mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail
      })
  )
  const { result } = renderHook(() => useMigrationPlugins('target', '/owned', () => true))
  await waitFor(() => expect(result.current.records).not.toBeNull())
  let action!: Promise<boolean>
  act(() => {
    action = result.current.plan('candidate')
  })
  await waitFor(() => expect(api.plan).toHaveBeenCalledOnce())
  act(() => notifyAccountContextChange('target'))
  await act(async () => {
    reject(new Error('late failure'))
    await action
  })
  expect(result.current.state).toBeNull()
  expect(result.current.unknownOperation).toBeNull()
  expect(api.read).not.toHaveBeenCalled()
  expect(api.apply).not.toHaveBeenCalled()
})
test('switching targets discards the old operation and ignores its late result', async () => {
  let complete!: (value: MigrationPluginStateResult) => void
  api.plan.mockImplementation(
    () =>
      new Promise(done => {
        complete = done
      })
  )
  const { result, rerender } = renderHook(
    ({ target }) => useMigrationPlugins(target, '/owned', () => true),
    { initialProps: { target: 'first' } }
  )
  await waitFor(() => expect(result.current.records).not.toBeNull())
  let action!: Promise<boolean>
  act(() => {
    action = result.current.plan('candidate')
  })
  const id = api.plan.mock.calls[0][0].requestId
  rerender({ target: 'second' })
  await act(async () => {
    complete(state(id))
    await action
  })
  expect(result.current.state).toBeNull()
  expect(api.capture).not.toHaveBeenCalled()
  expect(api.read).not.toHaveBeenCalled()
})
test('cancel remains available while a mutation acknowledgement is pending and stale acknowledgement cannot regress cancellation', async () => {
  let complete!: (value: MigrationPluginStateResult) => void
  api.apply.mockImplementation(
    () =>
      new Promise(done => {
        complete = done
      })
  )
  const { result } = renderHook(() => useMigrationPlugins('target', '/owned', () => true))
  await waitFor(() => expect(result.current.records).not.toBeNull())
  await act(() => result.current.open('operation'))
  let action!: Promise<boolean>
  act(() => {
    action = result.current.apply()
  })
  await waitFor(() => expect(api.apply).toHaveBeenCalledOnce())
  api.read.mockResolvedValue(state('operation', { sequence: 2 }))
  api.cancel.mockResolvedValue(
    state('operation', {
      sequence: 2,
      stage: 'cancelled',
      cancelRequested: true,
      cancelRevision: 1,
    })
  )
  await act(() => result.current.cancel())
  expect(api.cancel).toHaveBeenCalledExactlyOnceWith({
    operationId: 'operation',
    expectedSequence: 2,
  })
  await act(async () => {
    complete(state('operation', { sequence: 1 }))
    await action
  })
  expect(result.current.state?.job.stage).toBe('cancelled')
  expect(result.current.state?.job.cancelRevision).toBe(1)
})
test('previous catalog pages use the retained grant instead of silently rescanning changed source content', async () => {
  api.discover
    .mockResolvedValueOnce({ candidates: [], problems: [], nextCursor: 'catalog:10' })
    .mockResolvedValueOnce({ candidates: [], problems: [], nextCursor: null })
  const { result } = renderHook(() => useMigrationPlugins('target', '/owned', () => true))
  await waitFor(() => expect(result.current.records).not.toBeNull())
  await act(() => result.current.discover())
  await act(() => result.current.discover('catalog:10'))
  expect(result.current.sourcePage).toBe(1)
  act(() => result.current.previousSources())
  expect(result.current.sourcePage).toBe(0)
  expect(result.current.catalog?.nextCursor).toBe('catalog:10')
  expect(api.discover).toHaveBeenCalledTimes(2)
})
test('project discovery and explicit mapping use distinct original operation identities', async () => {
  const { result } = renderHook(() => useMigrationPlugins('target', '/owned', () => true))
  await waitFor(() => expect(result.current.records).not.toBeNull())
  act(() => result.current.setIncludeProject(true))
  await act(() => result.current.discover())
  expect(api.discover).toHaveBeenLastCalledWith({
    sources: ['claude-code'],
    cursor: undefined,
    includeProject: true,
  })
  await act(() => result.current.plan('candidate', undefined, true))
  const mapped = api.plan.mock.calls[0][0]
  expect(mapped.projectMapping).toBe('current_workspace')
  await act(() => result.current.plan('candidate'))
  const global = api.plan.mock.calls[1][0]
  expect(global.projectMapping).toBeUndefined()
  expect(global.requestId).not.toBe(mapped.requestId)
})
