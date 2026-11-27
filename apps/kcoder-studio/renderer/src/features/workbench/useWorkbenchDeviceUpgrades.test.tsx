import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { initialWorkbenchState } from './workbenchReducer'
import { useWorkbenchDeviceUpgrades } from './useWorkbenchDeviceUpgrades'

type Options = Parameters<typeof useWorkbenchDeviceUpgrades>[0]
type Handlers = Parameters<Options['services']['chatStream']['subscribe']>[0]
afterEach(() => vi.useRealTimers())

test.each(['scheduled', 'reading'] as const)('display changes preserve the %s device event refresh and its serial trailing read', async phase => {
  vi.useFakeTimers()
  let handlers!: Handlers
  let finish!: () => void
  const first = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const latest = vi.fn().mockResolvedValue(undefined)
  const subscribe = vi.fn((value: Handlers) => { handlers = value; return vi.fn() })
  const options = {
    userId: 9401, state: initialWorkbenchState, dispatch: vi.fn(), executorClient: {}, refreshDevices: first,
    services: { chatStream: { subscribe } },
  } as unknown as Options
  const hook = renderHook(props => useWorkbenchDeviceUpgrades(props), { initialProps: options })
  try {
    act(() => handlers.onDeviceSlotUpdate?.({}))
    if (phase === 'reading') await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    act(() => hook.rerender({ ...options, refreshDevices: latest,
      state: { ...initialWorkbenchState, projects: [], standaloneDeviceId: 'next' } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    if (phase === 'scheduled') {
      expect(first).not.toHaveBeenCalled()
      expect(latest).toHaveBeenCalledExactlyOnceWith({ useCacheFallback: false, trigger: 'device-event' })
    } else {
      act(() => { for (let i = 0; i < 100; i++) handlers.onDeviceSlotUpdate?.({}) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      expect(first).toHaveBeenCalledOnce()
      expect(latest).not.toHaveBeenCalled()
      await act(async () => { finish(); await vi.advanceTimersByTimeAsync(100) })
      expect(latest).toHaveBeenCalledExactlyOnceWith({ useCacheFallback: false, trigger: 'device-event' })
    }
    expect(subscribe).toHaveBeenCalledOnce()
  } finally { hook.unmount(); finish?.() }
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(latest).toHaveBeenCalledOnce()
})

test.each(['user', 'executor', 'stream'] as const)('a %s change retires the old device event queue without waking the new owner', async boundary => {
  vi.useFakeTimers()
  let handlers!: Handlers
  let finish!: () => void
  const first = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const latest = vi.fn().mockResolvedValue(undefined)
  const stop = vi.fn()
  const subscribe = vi.fn((value: Handlers) => { handlers = value; return stop })
  const options = {
    userId: 9402, state: initialWorkbenchState, dispatch: vi.fn(), executorClient: {}, refreshDevices: first,
    services: { chatStream: { subscribe } },
  } as unknown as Options
  const hook = renderHook(props => useWorkbenchDeviceUpgrades(props), { initialProps: options })
  try {
    act(() => handlers.onDeviceSlotUpdate?.({}))
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    const retired = handlers
    act(() => retired.onDeviceSlotUpdate?.({}))
    act(() => hook.rerender({ ...options, refreshDevices: latest,
      ...(boundary === 'user' ? { userId: 9403 }
        : boundary === 'executor' ? { executorClient: { ...options.executorClient } }
          : { services: { ...options.services, chatStream: { ...options.services.chatStream, subscribe } } }),
    }))
    expect(stop).toHaveBeenCalledOnce()
    act(() => retired.onDeviceSlotUpdate?.({}))
    await act(async () => { finish(); await vi.advanceTimersByTimeAsync(1_000) })
    expect(latest).not.toHaveBeenCalled()
    act(() => handlers.onDeviceSlotUpdate?.({}))
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(latest).toHaveBeenCalledExactlyOnceWith({ useCacheFallback: false, trigger: 'device-event' })
    expect(subscribe).toHaveBeenCalledTimes(2)
  } finally { hook.unmount(); finish?.() }
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(latest).toHaveBeenCalledOnce()
  expect(stop).toHaveBeenCalledTimes(2)
})

test('device bursts keep one running read and one trailing read without cloud manual refresh or post-unmount work', async () => {
  vi.useFakeTimers()
  let handlers!: Handlers
  let finish!: () => void
  const refreshDevices = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    .mockResolvedValue(undefined)
  const stop = vi.fn()
  const options = {
    userId: 9404,
    state: initialWorkbenchState,
    dispatch: vi.fn(),
    executorClient: {},
    refreshDevices,
    services: { chatStream: { subscribe: (value: Handlers) => { handlers = value; return stop } } },
  } as unknown as Options
  const hook = renderHook(() => useWorkbenchDeviceUpgrades(options))
  act(() => { for (let i = 0; i < 100; i++) handlers.onDeviceStatus?.({ device_id: 'event-owner', status: 'online' }) })
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(refreshDevices).toHaveBeenCalledExactlyOnceWith({ useCacheFallback: false, trigger: 'device-event' })
  act(() => { for (let i = 0; i < 100; i++) handlers.onDeviceSlotUpdate?.({}) })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(refreshDevices).toHaveBeenCalledTimes(1)
  await act(async () => { finish(); await vi.advanceTimersByTimeAsync(100) })
  expect(refreshDevices).toHaveBeenCalledTimes(2)
  act(() => handlers.onDeviceOffline?.({ device_id: 'event-owner' }))
  hook.unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(refreshDevices).toHaveBeenCalledTimes(2)
  expect(stop).toHaveBeenCalledOnce()
})
