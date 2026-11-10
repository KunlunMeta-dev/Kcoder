import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useExpertConversationRefresh } from './useExpertConversationRefresh'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('discovers Native background arrivals without overlapping reads and pauses hidden pages', async () => {
  vi.useFakeTimers()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let settle!: () => void
  const read = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { settle = resolve }))
    .mockResolvedValue(undefined)
  const { result, unmount } = renderHook(() => useExpertConversationRefresh(read))
  expect(read).toHaveBeenCalledTimes(1)
  act(() => { window.dispatchEvent(new Event('focus')); vi.advanceTimersByTime(20_000) })
  expect(read).toHaveBeenCalledTimes(1)
  await act(async () => { settle() })
  expect(result.current.busy).toBe(false)
  visibility.mockReturnValue('hidden')
  act(() => { vi.advanceTimersByTime(10_000) })
  expect(read).toHaveBeenCalledTimes(1)
  visibility.mockReturnValue('visible')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(read).toHaveBeenCalledTimes(2)
  unmount()
  act(() => { vi.advanceTimersByTime(20_000); window.dispatchEvent(new Event('focus')) })
  expect(read).toHaveBeenCalledTimes(2)
})

it('shows a failed read and recovers on an explicit retry without replaying a task', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const read = vi.fn().mockRejectedValueOnce(new Error('Native unavailable')).mockResolvedValue(undefined)
  const { result } = renderHook(() => useExpertConversationRefresh(read))
  await act(async () => {})
  expect(result.current.error).toBe(true)
  await act(async () => { await result.current.refresh() })
  expect(result.current.error).toBe(false)
  expect(read).toHaveBeenCalledTimes(2)
})
