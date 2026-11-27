import type { ReactNode } from 'react'
import { RetainedPage } from '@/components/layout/retainedPages'
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { sampleRuntimeClock } from '@/kcoder/runtimeClock'
import { useTurnProcessNow } from './useTurnProcessTime'
import type { TurnProcessPresentation } from './turnProcessPresentation'

vi.mock('@/kcoder/runtimeClock', () => ({ sampleRuntimeClock: vi.fn() }))
const presentation: TurnProcessPresentation = {
  key: 'active-attempt', ownerMessageId: 'message', status: 'running',
  canUseSummary: true, canCollapse: false, hasThinking: true, hasTools: false,
  startedAt: 1000, blocks: [],
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks() })

test('a hidden mount waits for visibility before sampling or ticking', async () => {
  vi.useFakeTimers()
  let visible = false
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
  vi.mocked(sampleRuntimeClock).mockResolvedValue({ serverTimeMs: 5000, monotonicTimeMs: 0 })
  const { result } = renderHook(() => useTurnProcessNow(presentation, 'target'))
  await act(async () => { vi.advanceTimersByTime(10_000) })
  expect(sampleRuntimeClock).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  expect(result.current).toBeUndefined()
  visible = true
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(sampleRuntimeClock).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(1)
  expect(result.current).toBeDefined()
})

test('hidden time does not rerender the transcript and foreground resumes with one target sample', async () => {
  vi.useFakeTimers()
  let visible = true, renders = 0
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
  vi.mocked(sampleRuntimeClock).mockImplementation(async () => ({ serverTimeMs: 5000, monotonicTimeMs: performance.now() }))
  const { unmount } = renderHook(() => { renders++; return useTurnProcessNow(presentation, 'target') })
  await act(async () => {})
  expect(vi.getTimerCount()).toBe(1)
  visible = false
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  const hiddenRenders = renders
  act(() => { vi.advanceTimersByTime(60_000) })
  expect(renders).toBe(hiddenRenders)
  expect(vi.getTimerCount()).toBe(0)
  expect(sampleRuntimeClock).toHaveBeenCalledTimes(1)
  visible = true
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(sampleRuntimeClock).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(1)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

test('a sample arriving while hidden cannot reactivate the timer', async () => {
  vi.useFakeTimers()
  let visible = true
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
  let resolve!: (value: Awaited<ReturnType<typeof sampleRuntimeClock>>) => void
  vi.mocked(sampleRuntimeClock).mockReturnValueOnce(new Promise(done => { resolve = done }))
    .mockResolvedValue({ serverTimeMs: 9000, monotonicTimeMs: 0 })
  const { result } = renderHook(() => useTurnProcessNow(presentation, 'target'))
  visible = false
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  await act(async () => { resolve({ serverTimeMs: 5000, monotonicTimeMs: 0 }) })
  expect(result.current).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
  visible = true
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(sampleRuntimeClock).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(1)
})

test('a terminal receipt received while hidden stays frozen without another clock sample', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const { result, rerender } = renderHook(({ turn }) => useTurnProcessNow(turn, 'target'),
    { initialProps: { turn: presentation } })
  rerender({ turn: { ...presentation, status: 'completed', canCollapse: true, completedAt: 9000 } })
  expect(result.current).toBe(9000)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(sampleRuntimeClock).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})


test('a retained hidden conversation neither samples nor ticks, and resumes through the same hook', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let active = false, renders = 0
  vi.mocked(sampleRuntimeClock).mockImplementation(async () => ({ serverTimeMs: 5000, monotonicTimeMs: performance.now() }))
  const { rerender, unmount } = renderHook(() => {
    renders++
    return useTurnProcessNow(presentation, 'target')
  }, { wrapper: ({ children }: { children: ReactNode }) => <RetainedPage open={active}>{children}</RetainedPage> })
  await act(async () => {})
  expect(sampleRuntimeClock).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  active = true
  await act(async () => { rerender() })
  expect(sampleRuntimeClock).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(1)
  active = false
  act(() => { rerender() })
  const hiddenRenders = renders
  act(() => { document.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(60_000) })
  expect(renders).toBe(hiddenRenders)
  expect(vi.getTimerCount()).toBe(0)
  expect(sampleRuntimeClock).toHaveBeenCalledTimes(1)
  active = true
  await act(async () => { rerender() })
  expect(sampleRuntimeClock).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(1)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

test('a retained page rejects its pre-hide sample and accepts a terminal receipt without resampling', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let active = true
  let resolve!: (value: Awaited<ReturnType<typeof sampleRuntimeClock>>) => void
  vi.mocked(sampleRuntimeClock).mockReturnValueOnce(new Promise(done => { resolve = done }))
  const { result, rerender } = renderHook(({ turn }) => useTurnProcessNow(turn, 'target'), {
    initialProps: { turn: presentation },
    wrapper: ({ children }: { children: ReactNode }) => <RetainedPage open={active}>{children}</RetainedPage>,
  })
  active = false
  rerender({ turn: presentation })
  await act(async () => { resolve({ serverTimeMs: 5000, monotonicTimeMs: 0 }) })
  expect(result.current).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
  const completed = { ...presentation, status: 'completed' as const, canCollapse: true, completedAt: 9000 }
  rerender({ turn: completed })
  expect(result.current).toBe(9000)
  active = true
  rerender({ turn: completed })
  expect(result.current).toBe(9000)
  expect(sampleRuntimeClock).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
