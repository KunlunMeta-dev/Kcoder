import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { formatRelativeSidebarTime, useSidebarRelativeTimeRefresh } from './runtimeSidebarTime'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('runtimeSidebarTime', () => {
  test('formats relative sidebar time from the supplied clock', () => {
    const now = new Date('2026-07-03T12:00:00.000Z').getTime()

    expect(formatRelativeSidebarTime('2026-07-03T11:59:30.000Z', now)).toBe('1m')
    expect(formatRelativeSidebarTime('2026-07-03T11:58:00.000Z', now)).toBe('2m')
    expect(formatRelativeSidebarTime('2026-07-03T10:00:00.000Z', now)).toBe('2h')
    expect(formatRelativeSidebarTime('2026-07-01T12:00:00.000Z', now)).toBe('2d')
    expect(formatRelativeSidebarTime('2026-06-12T12:00:00.000Z', now)).toBe('3w')
  })

  test('returns an empty string for missing or invalid values', () => {
    expect(formatRelativeSidebarTime()).toBe('')
    expect(formatRelativeSidebarTime('not-a-date')).toBe('')
  })

  test('hidden browser tabs stop sidebar renders and return with the current relative time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    let visible = true, renders = 0
    const start = Date.now() - 60_000
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
    const hook = renderHook(() => {
      renders++
      useSidebarRelativeTimeRefresh(true)
      return formatRelativeSidebarTime(start)
    })
    try {
      expect(hook.result.current).toBe('1m')
      visible = false
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      const before = renders
      for (let i = 0; i < 2; i++) act(() => vi.advanceTimersByTime(60_000))
      expect(renders).toBe(before)
      visible = true
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      expect(hook.result.current).toBe('3m')
    } finally { hook.unmount() }
    expect(vi.getTimerCount()).toBe(0)
  })

  test('closed sidebar surfaces own no ticker and catch up immediately when shown', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let renders = 0
    const start = Date.now() - 60_000
    const hook = renderHook(({ visible }) => {
      renders++
      useSidebarRelativeTimeRefresh(visible)
      return formatRelativeSidebarTime(start)
    }, { initialProps: { visible: false } })
    try {
      expect(vi.getTimerCount()).toBe(0)
      const before = renders
      act(() => vi.advanceTimersByTime(120_000))
      expect(renders).toBe(before)
      hook.rerender({ visible: true })
      expect(hook.result.current).toBe('3m')
      expect(vi.getTimerCount()).toBe(1)
      hook.rerender({ visible: false })
      expect(vi.getTimerCount()).toBe(0)
    } finally { hook.unmount() }
  })
})
