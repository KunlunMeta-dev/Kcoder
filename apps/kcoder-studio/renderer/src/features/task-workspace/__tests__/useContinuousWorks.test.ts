import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { requestLocalExecutor } from '@/host/localExecutor'
import { workspacePathKey } from '@/lib/workspace-path-identity'
import type { ContinuousWorkView } from '../../../../../shared/generated/contracts'
import { useContinuousWorks } from '../useContinuousWorks'

const host = vi.hoisted(() => ({ native: false, isCurrent: () => true }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: (serverId: string) => ({ key: serverId, isCurrent: host.isCurrent }),
}))
vi.mock('@/lib/runtime-environment', async original => ({
  ...(await original<object>()),
  isNativeGatewayHost: () => host.native,
}))

const executor = vi.mocked(requestLocalExecutor)
const owned = '/owned'
const key = workspacePathKey(owned)
function work(workId: string, title = workId): ContinuousWorkView {
  return {
    workId,
    threadId: 'original-thread',
    title,
    phase: 'pending',
    freshness: 'partial',
    revision: 1,
    requirementsRevision: 1,
  }
}
function pending(): Promise<never> {
  return new Promise<never>(() => {})
}

beforeEach(() => {
  host.native = false
  executor.mockReset()
})
afterEach(cleanup)

test('a pending read is shown as loading for the current target before any page settles', () => {
  executor.mockImplementation(pending)
  const { result } = renderHook(() => useContinuousWorks('owned-target', [owned], false, 0))
  expect(result.current[key]).toEqual({ status: 'loading', items: [] })
  expect(executor).toHaveBeenCalledWith(
    'runtime.continuousWork.list',
    { deviceId: 'owned-target', workspacePath: owned },
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  )
})

test('cursor pages merge into one observation and bounded pages are reported as partial', async () => {
  executor
    .mockResolvedValueOnce({
      status: 'more',
      pageCount: 1,
      items: [work('work-1')],
      nextCursor: 'cursor-1',
    })
    .mockResolvedValueOnce({ status: 'complete', pageCount: 1, items: [work('work-2')] })
  const { result } = renderHook(() => useContinuousWorks('owned-target', [owned], false, 0))
  await waitFor(() => expect(result.current[key]?.status).toBe('partial'))
  expect(result.current[key]?.items.map(item => item.workId)).toEqual(['work-1', 'work-2'])
  expect(executor).toHaveBeenLastCalledWith(
    'runtime.continuousWork.list',
    { deviceId: 'owned-target', workspacePath: owned, cursor: 'cursor-1' },
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  )
})

test('rereading the same target keeps already observed work visible while it is pending', async () => {
  executor.mockResolvedValueOnce({ status: 'complete', pageCount: 1, items: [work('work-1')] })
  const { result, rerender } = renderHook(
    ({ revision }: { revision: number }) => useContinuousWorks('owned-target', [owned], false, revision),
    { initialProps: { revision: 0 } }
  )
  await waitFor(() => expect(result.current[key]?.status).toBe('complete'))
  executor.mockImplementation(pending)
  rerender({ revision: 1 })
  expect(result.current[key]).toEqual({ status: 'loading', items: [work('work-1')] })
})

test('resuming after a pause keeps the work pending until the reread settles', async () => {
  executor.mockResolvedValueOnce({ status: 'complete', pageCount: 1, items: [work('work-1')] })
  const { result, rerender } = renderHook(
    ({ paused }: { paused: boolean }) => useContinuousWorks('owned-target', [owned], paused, 0),
    { initialProps: { paused: false } }
  )
  await waitFor(() => expect(result.current[key]?.status).toBe('complete'))
  rerender({ paused: true })
  expect(result.current[key]).toEqual({ status: 'loading', items: [work('work-1')] })
  executor.mockImplementation(pending)
  rerender({ paused: false })
  expect(result.current[key]).toEqual({ status: 'loading', items: [work('work-1')] })
})

test('an unavailable page keeps the work that was already observed', async () => {
  executor.mockResolvedValueOnce({ status: 'complete', pageCount: 1, items: [work('work-1')] })
  const { result, rerender } = renderHook(
    ({ revision }: { revision: number }) => useContinuousWorks('owned-target', [owned], false, revision),
    { initialProps: { revision: 0 } }
  )
  await waitFor(() => expect(result.current[key]?.status).toBe('complete'))
  executor.mockRejectedValue(new Error('target went away'))
  rerender({ revision: 1 })
  await waitFor(() => expect(result.current[key]?.status).toBe('unavailable'))
  expect(result.current[key]?.items.map(item => item.workId)).toEqual(['work-1'])
})

test('leaving the board aborts its in-flight read', async () => {
  const signals: AbortSignal[] = []
  executor.mockImplementation((_method, _params, options) => {
    if (options?.signal) signals.push(options.signal)
    return pending()
  })
  const { unmount } = renderHook(() => useContinuousWorks('owned-target', [owned], false, 0))
  await waitFor(() => expect(signals).toHaveLength(1))
  act(() => unmount())
  expect(signals[0]?.aborted).toBe(true)
})
