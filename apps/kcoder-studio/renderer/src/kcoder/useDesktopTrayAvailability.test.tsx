import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useDesktopTrayAvailability } from './useDesktopTrayAvailability'

afterEach(() => { delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost })
test('a focus read revokes the old positive projection while pending and never reuses it after failure', async () => {
  let fail!: (error: Error) => void
  const host = { getTrayCapabilities: vi.fn().mockResolvedValueOnce({ available: true }).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject })) }
  Object.assign(window, { kcoderDesktopHost: host })
  const { result } = renderHook(() => useDesktopTrayAvailability())
  await waitFor(() => expect(result.current).toBe('available'))
  act(() => { window.dispatchEvent(new Event('focus')) })
  expect(result.current).toBe('unknown')
  await act(async () => { fail(new Error('owned capability read failed')) })
  expect(result.current).toBe('unknown')
})
test('a late old-host positive cannot replace a new-host unavailable result', async () => {
  let finish!: (value: { available: boolean }) => void
  Object.assign(window, { kcoderDesktopHost: { getTrayCapabilities: () => new Promise(resolve => { finish = resolve }) } })
  const { result, rerender } = renderHook(() => useDesktopTrayAvailability())
  expect(result.current).toBe('unknown')
  Object.assign(window, { kcoderDesktopHost: { getTrayCapabilities: async () => ({ available: false }) } })
  rerender()
  await waitFor(() => expect(result.current).toBe('unavailable'))
  await act(async () => { finish({ available: true }) })
  expect(result.current).toBe('unavailable')
})


test('ordinary Web focus events do not update the observation without a native host', async () => {
  delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost
  const rendered = vi.fn()
  const page = renderHook(() => { rendered(); return useDesktopTrayAvailability() })
  try {
    await act(async () => {})
    expect(page.result.current).toBe('unknown')
    const initial = rendered.mock.calls.length
    for (let index = 0; index < 40; index++) await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(rendered.mock.calls.length - initial).toBe(0)
    const host = { getTrayCapabilities: vi.fn().mockResolvedValueOnce({ available: true })
      .mockResolvedValue({ available: false }) }
    Object.assign(window, { kcoderDesktopHost: host })
    page.rerender()
    await waitFor(() => expect(page.result.current).toBe('available'))
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(page.result.current).toBe('unavailable')
    expect(host.getTrayCapabilities).toHaveBeenCalledTimes(2)
  } finally { page.unmount() }
})
