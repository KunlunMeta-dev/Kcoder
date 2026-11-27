import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { notifyRuntimeWorkChanged } from '@/kcoder/runtimeWorkEvents'
import { useWorkbenchDataRefresh } from './useWorkbenchDataRefresh'
import { initialWorkbenchState } from './workbenchReducer'
import { EMPTY_RUNTIME_WORK } from './workbenchCloudStatus'
import { deferred } from './WorkbenchProvider.test-support'

afterEach(() => { vi.useRealTimers(); localStorage.clear() })

function setup(holdBootstrap = false) {
  const devices = deferred<[]>()
  const listRuntimeWork = vi.fn().mockResolvedValue(EMPTY_RUNTIME_WORK)
  const dispatch = vi.fn()
  const options = {
    user: { id: 9511, user_name: 'work-reader', email: 'reader@example.com' },
    state: initialWorkbenchState,
    dispatch,
    services: { teamApi: { getDefaultWorkbenchTeam: vi.fn().mockResolvedValue(null) } },
    executorClient: {
      commands: { listDevices: vi.fn().mockImplementation(() => holdBootstrap ? devices.promise : Promise.resolve([])) },
      runtime: { listRuntimeWork },
    },
  } as unknown as Parameters<typeof useWorkbenchDataRefresh>[0]
  const view = renderHook(props => useWorkbenchDataRefresh(props), { initialProps: options })
  return { ...view, options, devices, dispatch, listRuntimeWork }
}

async function bootstrap(f: ReturnType<typeof setup>) {
  await waitFor(() => expect(f.dispatch.mock.calls.some(([action]) => action.type === 'runtime_work_refreshed')).toBe(true))
  f.dispatch.mockClear()
  f.listRuntimeWork.mockClear()
  vi.useFakeTimers()
}

test('a completed bootstrap read covers a notification received before that read starts', async () => {
  vi.useFakeTimers()
  const f = setup(true)
  try {
    act(() => notifyRuntimeWorkChanged())
    await act(async () => { f.devices.resolve([]) })
    expect(f.listRuntimeWork).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(f.listRuntimeWork).toHaveBeenCalledOnce()
  } finally { f.unmount(); f.devices.resolve([]) }
})

test('a notification during bootstrap does not wait for the older read', async () => {
  const f = setup(true), held = deferred<typeof EMPTY_RUNTIME_WORK>()
  f.listRuntimeWork.mockReturnValueOnce(held.promise)
  vi.useFakeTimers()
  try {
    await act(async () => { f.devices.resolve([]) })
    expect(f.listRuntimeWork).toHaveBeenCalledOnce()
    act(() => notifyRuntimeWorkChanged())
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(f.listRuntimeWork).toHaveBeenCalledTimes(2)
    await act(async () => { held.resolve(EMPTY_RUNTIME_WORK); await vi.advanceTimersByTimeAsync(1000) })
    expect(f.listRuntimeWork).toHaveBeenCalledTimes(2)
  } finally { f.unmount(); held.resolve(EMPTY_RUNTIME_WORK) }
})

test('a failed bootstrap does not consume the pending notification', async () => {
  vi.useFakeTimers()
  const f = setup(true)
  f.listRuntimeWork.mockRejectedValueOnce(new Error('initial directory unavailable'))
  try {
    act(() => notifyRuntimeWorkChanged())
    await act(async () => { f.devices.resolve([]) })
    expect(f.listRuntimeWork).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(f.listRuntimeWork).toHaveBeenCalledTimes(2)
    expect(f.dispatch.mock.calls.some(([action]) => action.type === 'runtime_work_refreshed')).toBe(true)
  } finally { f.unmount(); f.devices.resolve([]) }
})

test.each(['success', 'failure'] as const)('a manual %s settles before the queued notification is reconciled', async outcome => {
  const f = setup(), held = deferred<typeof EMPTY_RUNTIME_WORK>()
  await bootstrap(f)
  f.listRuntimeWork.mockReturnValueOnce(held.promise)
  let reading: Promise<void> | undefined
  try {
    act(() => notifyRuntimeWorkChanged())
    act(() => { reading = f.result.current.refreshWorkLists({ refreshDevices: false }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(f.listRuntimeWork).toHaveBeenCalledOnce()
    await act(async () => {
      if (outcome === 'failure') held.reject(new Error('directory unavailable'))
      else held.resolve(EMPTY_RUNTIME_WORK)
      await reading
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(f.listRuntimeWork).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 2)
    await act(async () => { await f.result.current.refreshWorkLists({ refreshDevices: false }) })
    expect(f.listRuntimeWork).toHaveBeenCalledTimes(outcome === 'success' ? 2 : 3)
  } finally { f.unmount(); held.resolve(EMPTY_RUNTIME_WORK); await reading }
})

test('notifications received after a manual read starts require a newer read without waiting for it', async () => {
  const f = setup(), held = deferred<typeof EMPTY_RUNTIME_WORK>()
  await bootstrap(f)
  f.listRuntimeWork.mockReturnValueOnce(held.promise)
  let reading: Promise<void> | undefined
  try {
    act(() => { reading = f.result.current.refreshWorkLists({ refreshDevices: false }) })
    act(() => { for (let i = 0; i < 100; i++) notifyRuntimeWorkChanged() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(f.listRuntimeWork).toHaveBeenCalledTimes(2)
    await act(async () => { held.resolve(EMPTY_RUNTIME_WORK); await reading; await vi.advanceTimersByTimeAsync(1000) })
    expect(f.listRuntimeWork).toHaveBeenCalledTimes(2)
  } finally { f.unmount(); held.resolve(EMPTY_RUNTIME_WORK); await reading }
})

test.each(['user', 'executor', 'unmount'] as const)('a waiting observer cannot read or publish after %s retirement', async boundary => {
  const f = setup(), held = deferred<typeof EMPTY_RUNTIME_WORK>()
  await bootstrap(f)
  f.listRuntimeWork.mockReturnValueOnce(held.promise)
  let reading: Promise<void> | undefined
  try {
    act(() => notifyRuntimeWorkChanged())
    act(() => { reading = f.result.current.refreshWorkLists({ refreshDevices: false }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(f.listRuntimeWork).toHaveBeenCalledOnce()
    await act(async () => {
      if (boundary === 'unmount') f.unmount()
      else f.rerender({ ...f.options, ...(boundary === 'user'
        ? { user: { ...f.options.user, id: 9512 } }
        : { executorClient: { ...f.options.executorClient } }) })
    })
    f.dispatch.mockClear()
    const calls = f.listRuntimeWork.mock.calls.length
    await act(async () => { held.resolve(EMPTY_RUNTIME_WORK); await reading; await vi.advanceTimersByTimeAsync(1000) })
    expect(f.listRuntimeWork).toHaveBeenCalledTimes(calls)
    expect(f.dispatch).not.toHaveBeenCalled()
  } finally { f.unmount(); held.resolve(EMPTY_RUNTIME_WORK); await reading }
})

test.each([
  ['api', false], ['scope', false], ['api', true], ['scope', true],
] as const)('an old refresh callback cannot read under a replacement %s context (return=%s)', async (boundary, returnToOriginal) => {
  const f = setup()
  await bootstrap(f)
  const oldRefresh = f.result.current.refreshWorkLists
  try {
    await act(async () => { f.rerender({ ...f.options, ...(boundary === 'api'
      ? { services: { ...f.options.services, cloudBackgroundApi: {} } }
      : { remoteCacheScope: { targetId: 'test-target', principalId: 'new-owner' } }) }) })
    expect(f.listRuntimeWork).toHaveBeenCalledOnce()
    if (returnToOriginal) await act(async () => { f.rerender(f.options) })
    const reads = f.listRuntimeWork.mock.calls.length
    await act(async () => {
      await expect(oldRefresh({ requireRuntimeWork: true })).rejects.toThrow('source changed')
      await expect(oldRefresh()).resolves.toBeUndefined()
    })
    expect(f.listRuntimeWork).toHaveBeenCalledTimes(reads)
  } finally { f.unmount() }
})

test.each([false, true])('an observer superseded by a manual read retires without a failure warning (pending=%s)', async pending => {
  const f = setup(), held = deferred<typeof EMPTY_RUNTIME_WORK>(), manual = deferred<typeof EMPTY_RUNTIME_WORK>()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await bootstrap(f)
  f.listRuntimeWork.mockReturnValueOnce(held.promise)
  if (pending) f.listRuntimeWork.mockReturnValueOnce(manual.promise)
  let reading: Promise<void> | undefined
  try {
    act(() => notifyRuntimeWorkChanged())
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    await act(async () => {
      reading = f.result.current.refreshWorkLists({ refreshDevices: false })
      if (!pending) await reading
    })
    await act(async () => { held.resolve(EMPTY_RUNTIME_WORK); await vi.advanceTimersByTimeAsync(1000) })
    expect(f.listRuntimeWork).toHaveBeenCalledTimes(2)
    expect(warn).not.toHaveBeenCalled()
  } finally {
    f.unmount(); held.resolve(EMPTY_RUNTIME_WORK); manual.resolve(EMPTY_RUNTIME_WORK)
    await reading; warn.mockRestore()
  }
})

test.each([true, false])('an observer failure preserves cancellation versus a real fault (cancelled=%s)', async cancelled => {
  const f = setup(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await bootstrap(f)
  f.listRuntimeWork.mockRejectedValueOnce(cancelled ? new DOMException('Read cancelled', 'AbortError') : new Error('Directory unavailable'))
  try {
    act(() => notifyRuntimeWorkChanged())
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(f.listRuntimeWork).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledTimes(cancelled ? 0 : 1)
    act(() => notifyRuntimeWorkChanged())
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(f.listRuntimeWork).toHaveBeenCalledTimes(2)
  } finally { f.unmount(); warn.mockRestore() }
})

test('a superseded startup device read publishes neither an older list nor a selection', async () => {
  const f = setup(true)
  vi.mocked(f.options.executorClient.commands.listDevices).mockResolvedValueOnce([
    { id: 2, device_id: 'manual-current', name: 'Manual', status: 'online', is_default: true },
  ])
  try {
    await act(async () => { await f.result.current.refreshDevices() })
    await act(async () => { f.devices.resolve([]) })
    await waitFor(() => expect(f.dispatch.mock.calls.some(([action]) => action.type === 'bootstrapped')).toBe(true))
    const action = f.dispatch.mock.calls.find(([action]) => action.type === 'bootstrapped')![0]
    expect(action.devices).toBeUndefined()
    expect(action.standaloneDeviceId).toBeUndefined()
    expect(f.options.executorClient.commands.listDevices).toHaveBeenCalledTimes(2)
  } finally { f.unmount(); f.devices.resolve([]) }
})
