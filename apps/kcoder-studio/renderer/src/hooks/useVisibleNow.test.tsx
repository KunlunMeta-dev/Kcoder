import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RetainedPage } from '@/components/layout/retainedPages'
import { useVisibleNow } from './useVisibleNow'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

test.each([100, 1000])('local %s ms clock pauses hidden ticks and refreshes immediately on visibility', intervalMs => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  let visible = true, renders = 0
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
  const { result, unmount } = renderHook(() => { renders++; return useVisibleNow(true, intervalMs) })
  act(() => { vi.advanceTimersByTime(intervalMs) })
  expect(result.current).toBe(1000 + intervalMs)
  visible = false
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  const before = renders
  act(() => { vi.advanceTimersByTime(10_000) })
  expect(renders).toBe(before)
  expect(vi.getTimerCount()).toBe(0)
  visible = true
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(result.current).toBe(Date.now())
  expect(vi.getTimerCount()).toBe(1)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

test('retained hidden, disabled and disposed clocks own no ticker', () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let active = false
  const { rerender, unmount } = renderHook(({ running }) => useVisibleNow(running, 100), {
    initialProps: { running: true },
    wrapper: ({ children }: { children: ReactNode }) => <RetainedPage open={active}>{children}</RetainedPage>,
  })
  expect(vi.getTimerCount()).toBe(0)
  active = true
  rerender({ running: true })
  expect(vi.getTimerCount()).toBe(1)
  rerender({ running: false })
  expect(vi.getTimerCount()).toBe(0)
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(vi.getTimerCount()).toBe(0)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})
