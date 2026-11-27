import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import {
  TRANSIENT_NOTICE_FADE_MS,
  TRANSIENT_NOTICE_VISIBLE_MS,
  useTransientNotice,
} from './useTransientNotice'

afterEach(() => vi.useRealTimers())

test('releasing a notice held during a fade starts a fresh visible interval', () => {
  vi.useFakeTimers()
  const clear = vi.fn()
  const { result, rerender } = renderHook(({ held }) => useTransientNotice('context', clear, held), {
    initialProps: { held: false },
  })
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

  advance(TRANSIENT_NOTICE_VISIBLE_MS)
  expect(result.current).toBe(true)
  rerender({ held: true })
  advance(TRANSIENT_NOTICE_VISIBLE_MS + TRANSIENT_NOTICE_FADE_MS)
  expect(result.current).toBe(false)
  expect(clear).not.toHaveBeenCalled()

  rerender({ held: false })
  expect(result.current).toBe(false)
  advance(TRANSIENT_NOTICE_VISIBLE_MS - 1)
  expect(result.current).toBe(false)
  advance(1)
  expect(result.current).toBe(true)
  advance(TRANSIENT_NOTICE_FADE_MS)
  expect(clear).toHaveBeenCalledExactlyOnceWith('context')
})

test('displaying the same value again does not inherit the old fade', () => {
  vi.useFakeTimers()
  const clear = vi.fn()
  const { result, rerender } = renderHook(
    ({ notice }: { notice: string | null }) => useTransientNotice(notice, clear),
    { initialProps: { notice: 'context' } }
  )
  act(() => { vi.advanceTimersByTime(TRANSIENT_NOTICE_VISIBLE_MS) })
  expect(result.current).toBe(true)

  rerender({ notice: null })
  rerender({ notice: 'context' })
  expect(result.current).toBe(false)
  expect(clear).not.toHaveBeenCalled()
})
