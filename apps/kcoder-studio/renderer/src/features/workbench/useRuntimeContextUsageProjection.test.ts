import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import type { RuntimeContextUsage } from '@/types/api'
import { getRuntimeTaskRouteKey } from './workbenchRuntimeHelpers'
import { useRuntimeContextUsageProjection } from './useRuntimeContextUsageProjection'

const address = { deviceId: 'usage-test', taskId: 'subject' }
const key = getRuntimeTaskRouteKey(address)
function usage(totalTokens: number): RuntimeContextUsage {
  const counts = { totalTokens, inputTokens: 1, cachedInputTokens: 0, outputTokens: totalTokens - 1, reasoningOutputTokens: 0 }
  return { total: counts, last: counts, modelContextWindow: 1024 }
}
afterEach(() => vi.useRealTimers())

test('a continuous stream publishes the latest use on a fixed interval and flushes on settlement', () => {
  vi.useFakeTimers()
  const { result, unmount } = renderHook(useRuntimeContextUsageProjection)
  for (let i = 1; i <= 10; i++) {
    act(() => { result.current.record(address, usage(i)); vi.advanceTimersByTime(9) })
  }
  expect(result.current.byTask[key]).toBeUndefined()
  act(() => vi.advanceTimersByTime(10))
  expect(result.current.byTask[key]).toEqual(usage(10))
  act(() => { result.current.record(address, usage(11)); result.current.flush() })
  expect(result.current.byTask[key]).toEqual(usage(11))
  unmount()
})

test('restored usage supersedes earlier buffered deltas and a retired account cannot publish one', () => {
  vi.useFakeTimers()
  const { result, unmount } = renderHook(useRuntimeContextUsageProjection)
  act(() => { result.current.record(address, usage(1)); result.current.record(address, usage(5), true) })
  expect(result.current.byTask[key]).toEqual(usage(5))
  act(() => { result.current.record(address, usage(6)); notifyAccountContextChange(address.deviceId); vi.advanceTimersByTime(110) })
  expect(result.current.byTask[key]).toEqual(usage(5))
  act(() => result.current.record(address, usage(7)))
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})
