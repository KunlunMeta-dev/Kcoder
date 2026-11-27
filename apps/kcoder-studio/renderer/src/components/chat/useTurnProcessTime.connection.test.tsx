import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RetainedPage } from '@/components/layout/retainedPages'
import { sampleRuntimeClock, type RuntimeClockSample } from '@/kcoder/runtimeClock'
import { useTurnProcessNow } from './useTurnProcessTime'
import type { TurnProcessPresentation } from './turnProcessPresentation'

vi.mock('@/kcoder/runtimeClock', () => ({ sampleRuntimeClock: vi.fn() }))
const turn: TurnProcessPresentation = {
  key: 'connection-attempt', ownerMessageId: 'message', status: 'running',
  canUseSummary: true, canCollapse: false, hasThinking: true, hasTools: false,
  startedAt: 1000, blocks: [],
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks() })

test.each(['rejected', 'unavailable'] as const)('a slow then %s resample never blocks the existing local clock', async outcome => {
  vi.useFakeTimers()
  let visible = true, monotonic = 100
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
  let resolve!: (sample: RuntimeClockSample | null) => void
  let reject!: (error: Error) => void
  vi.mocked(sampleRuntimeClock).mockResolvedValueOnce({ serverTimeMs: 5000, monotonicTimeMs: monotonic })
    .mockReturnValueOnce(new Promise((done, fail) => { resolve = done; reject = fail }))
  const { result, rerender } = renderHook(({ presentation }) => useTurnProcessNow(presentation, 'target'),
    { initialProps: { presentation: turn } })
  await act(async () => {})
  expect(result.current).toBe(5000)
  visible = false
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  monotonic += 10_000
  act(() => { vi.advanceTimersByTime(10_000) })
  expect(result.current).toBe(5000)
  expect(vi.getTimerCount()).toBe(0)
  visible = true
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(result.current).toBe(15_000)
  monotonic += 2000
  act(() => { vi.advanceTimersByTime(2000) })
  expect(result.current).toBe(17_000)
  await act(async () => { if (outcome === 'rejected') reject(new Error('offline')); else resolve(null) })
  vi.setSystemTime('2040-01-01')
  monotonic += 1000
  act(() => { vi.advanceTimersByTime(1000) })
  expect(result.current).toBe(18_000)
  expect(sampleRuntimeClock).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(1)
  rerender({ presentation: { ...turn, status: 'completed', canCollapse: true, completedAt: 12_000 } })
  expect(result.current).toBe(12_000)
  expect(vi.getTimerCount()).toBe(0)
})

test('a retained page resumes immediately and an older calibration cannot move running time backward', async () => {
  vi.useFakeTimers()
  let active = true, monotonic = 100
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
  let resolve!: (sample: RuntimeClockSample | null) => void
  vi.mocked(sampleRuntimeClock).mockResolvedValueOnce({ serverTimeMs: 5000, monotonicTimeMs: monotonic })
    .mockReturnValueOnce(new Promise(done => { resolve = done }))
  const { result, rerender } = renderHook(() => useTurnProcessNow(turn, 'target'), {
    wrapper: ({ children }: { children: ReactNode }) => <RetainedPage open={active}>{children}</RetainedPage>,
  })
  await act(async () => {})
  active = false
  rerender()
  monotonic += 10_000
  act(() => { vi.advanceTimersByTime(10_000) })
  active = true
  await act(async () => { rerender() })
  expect(result.current).toBe(15_000)
  await act(async () => { resolve({ serverTimeMs: 6000, monotonicTimeMs: monotonic }) })
  expect(result.current).toBe(15_000)
  monotonic += 1000
  act(() => { vi.advanceTimersByTime(1000) })
  expect(result.current).toBe(16_000)
  expect(vi.getTimerCount()).toBe(1)
})

test('a previous target or attempt clock is never used while its replacement is still offline', async () => {
  vi.useFakeTimers()
  vi.mocked(sampleRuntimeClock).mockResolvedValueOnce({ serverTimeMs: 5000, monotonicTimeMs: performance.now() })
    .mockReturnValue(new Promise(() => {}))
  const { result, rerender } = renderHook(({ presentation, server }) => useTurnProcessNow(presentation, server),
    { initialProps: { presentation: turn, server: 'old' } })
  await act(async () => {})
  expect(result.current).toBe(5000)
  rerender({ presentation: { ...turn, key: 'another-attempt' }, server: 'new' })
  act(() => { vi.advanceTimersByTime(10_000) })
  expect(result.current).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})
