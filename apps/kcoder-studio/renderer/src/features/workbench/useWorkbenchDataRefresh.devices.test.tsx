import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useWorkbenchDataRefresh } from './useWorkbenchDataRefresh'
import { initialWorkbenchState } from './workbenchReducer'
import { EMPTY_RUNTIME_WORK, readCachedDeviceList } from './workbenchCloudStatus'
import { createDevice, createRuntimeWork, deferred } from './WorkbenchProvider.test-support'
import { WorkspaceScanCancelledError } from '@/kcoder/workspaceScanError'
import type { DeviceInfo } from '@/types/api'

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })

async function setup() {
  const original = createDevice({ capabilities: [] })
  const dispatch = vi.fn()
  const listDevices = vi.fn().mockResolvedValue([original])
  const options = {
    user: { id: 9401, user_name: 'device-reader', email: 'reader@example.com' },
    state: { ...initialWorkbenchState, devices: [original] }, dispatch,
    services: { teamApi: { getDefaultWorkbenchTeam: vi.fn().mockResolvedValue(null) } },
    executorClient: { commands: { listDevices }, runtime: { listRuntimeWork: vi.fn().mockResolvedValue(EMPTY_RUNTIME_WORK) } },
  } as unknown as Parameters<typeof useWorkbenchDataRefresh>[0]
  const view = renderHook(props => useWorkbenchDataRefresh(props), { initialProps: options })
  await waitFor(() => expect(dispatch.mock.calls.some(([action]) => action.type === 'runtime_work_refreshed')).toBe(true))
  dispatch.mockClear(); listDevices.mockClear()
  return { ...view, original, dispatch, listDevices, options }
}

test('work-only refreshes do not reread or rewrite the unchanged device directory', async () => {
  const f = await setup(), write = vi.spyOn(Storage.prototype, 'setItem')
  try {
    for (let i = 0; i < 10; i++) await act(async () => {
      await f.result.current.refreshWorkLists({ refreshDevices: false })
    })
    expect(f.listDevices).not.toHaveBeenCalled()
    expect(f.dispatch.mock.calls.some(([action]) => action.type === 'lists_refreshed' || action.type === 'devices_refreshed')).toBe(false)
    expect(write.mock.calls.filter(([key]) => key === 'wework.workbench.lastNonEmptyDevices')).toHaveLength(0)
  } finally { write.mockRestore(); f.unmount() }
})

for (const method of ['refreshDevices', 'refreshWorkLists'] as const) {
  test.each([new WorkspaceScanCancelledError(), new DOMException('Read cancelled', 'AbortError')])(
    `${method} does not turn cancellation into a cached device refresh (%s)`, async error => {
      const f = await setup()
      try {
        const cached = readCachedDeviceList()
        f.listDevices.mockRejectedValueOnce(error)
        await act(async () => { await expect(f.result.current[method]()).resolves.toBeUndefined() })
        expect(f.dispatch.mock.calls.filter(([action]) => action.type !== 'runtime_work_refreshed')).toHaveLength(0)
        expect(readCachedDeviceList()).toEqual(cached)
      } finally { f.unmount() }
    }
  )
}

test.each(['user', 'executor', 'unmount'] as const)('late device refresh cannot publish or rewrite cache after %s retirement', async boundary => {
  const f = await setup(), held = deferred<DeviceInfo[]>()
  const late = createDevice({ device_id: 'retired-device', name: 'Retired' })
  f.listDevices.mockReturnValueOnce(held.promise)
  const reading = f.result.current.refreshDevices()
  const outcome = reading.catch(error => error)
  try {
    if (boundary === 'unmount') f.unmount()
    else await act(async () => { f.rerender({ ...f.options, ...(boundary === 'user'
      ? { user: { ...f.options.user, id: 9402 } }
      : { executorClient: { ...f.options.executorClient } }) }) })
    const cached = readCachedDeviceList()
    f.dispatch.mockClear()
    await act(async () => { held.resolve([late]); await expect(outcome).resolves.toBeUndefined() })
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(readCachedDeviceList()).toEqual(cached)
  } finally { held.resolve([]); await outcome; f.unmount() }
})

for (const method of ['refreshDevices', 'refreshWorkLists'] as const) {
  test.each(['pending', 'success', 'failure'] as const)(`${method} cannot replace a newer %s device read`, async phase => {
    const f = await setup(), old = deferred<DeviceInfo[]>(), newer = deferred<DeviceInfo[]>()
    const next = createDevice({ device_id: 'new-device', name: 'New' })
    f.listDevices.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise)
    const reading = f.result.current[method]().catch(error => error)
    const current = f.result.current.refreshDevices({ useCacheFallback: false }).catch(error => error)
    try {
      if (phase === 'success') await act(async () => { newer.resolve([next]); await current })
      if (phase === 'failure') await act(async () => { newer.reject(new Error('Current health unavailable')); await current })
      const cached = readCachedDeviceList()
      f.dispatch.mockClear()
      await act(async () => {
        old.resolve([createDevice({ device_id: 'old-device', name: 'Old' })])
        await expect(reading).resolves.toBeUndefined()
      })
      expect(f.dispatch.mock.calls.filter(([action]) => action.type !== 'runtime_work_refreshed')).toHaveLength(0)
      expect(readCachedDeviceList()).toEqual(cached)
      expect(f.listDevices).toHaveBeenCalledTimes(2)
    } finally { old.resolve([]); newer.resolve([next]); await act(async () => { await reading; await current }); f.unmount() }
  })
}

test('ordinary device failure keeps the existing cache fallback, but explicit no-fallback rejects', async () => {
  const f = await setup()
  try {
    f.listDevices.mockRejectedValue(new Error('Device temporarily unavailable'))
    await act(async () => { await f.result.current.refreshDevices() })
    expect(f.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'devices_refreshed', devices: [f.original] }))
    f.dispatch.mockClear()
    await act(async () => {
      await expect(f.result.current.refreshDevices({ useCacheFallback: false })).rejects.toThrow('Device temporarily unavailable')
    })
    expect(f.dispatch).not.toHaveBeenCalled()
  } finally { f.unmount() }
})

test('a required work refresh still rejects a cancelled device read instead of acknowledging completion', async () => {
  const f = await setup()
  try {
    f.listDevices.mockRejectedValueOnce(new WorkspaceScanCancelledError())
    await act(async () => {
      await expect(f.result.current.refreshWorkLists({ requireRuntimeWork: true })).rejects.toThrow('superseded')
    })
    expect(f.dispatch).not.toHaveBeenCalled()
  } finally { f.unmount() }
})

test('a work scan cannot republish its earlier device result after a newer health refresh', async () => {
  const f = await setup(), work = deferred<typeof EMPTY_RUNTIME_WORK>()
  try {
    vi.mocked(f.options.executorClient.runtime.listRuntimeWork).mockReturnValueOnce(work.promise)
    const reading = f.result.current.refreshWorkLists()
    await act(async () => { await Promise.resolve() })
    const next = createDevice({ device_id: 'new-device', name: 'New' })
    f.listDevices.mockResolvedValueOnce([next])
    await act(async () => { await f.result.current.refreshDevices() })
    const cached = readCachedDeviceList()
    f.dispatch.mockClear()
    await act(async () => { work.resolve(EMPTY_RUNTIME_WORK); await reading })
    expect(f.dispatch.mock.calls.filter(([action]) => action.type !== 'runtime_work_refreshed')).toHaveLength(0)
    expect(readCachedDeviceList()).toEqual(cached)
  } finally { work.resolve(EMPTY_RUNTIME_WORK); f.unmount() }
})

test('a newer device refresh preserves the independently completed work directory', async () => {
  const f = await setup(), work = deferred<typeof EMPTY_RUNTIME_WORK>()
  try {
    vi.mocked(f.options.executorClient.runtime.listRuntimeWork).mockReturnValueOnce(work.promise)
    const reading = f.result.current.refreshWorkLists()
    await act(async () => { await Promise.resolve() })
    f.listDevices.mockResolvedValueOnce([createDevice({ device_id: 'new-device' })])
    await act(async () => { await f.result.current.refreshDevices() })
    f.dispatch.mockClear()
    const completed = createRuntimeWork()
    await act(async () => { work.resolve(completed); await reading })
    expect(f.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'runtime_work_refreshed', runtimeWork: expect.objectContaining({ totalTasks: completed.totalTasks }),
    }))
    expect(f.dispatch.mock.calls.some(([action]) => action.type === 'lists_refreshed' || action.type === 'devices_refreshed')).toBe(false)
  } finally { work.resolve(EMPTY_RUNTIME_WORK); f.unmount() }
})

test.each(['user', 'executor'] as const)('a retained callback cannot start a device read after %s changes', async boundary => {
  const f = await setup(), previous = f.result.current.refreshDevices
  try {
    await act(async () => { f.rerender({ ...f.options, ...(boundary === 'user'
      ? { user: { ...f.options.user, id: 9402 } }
      : { executorClient: { ...f.options.executorClient } }) }) })
    f.listDevices.mockClear(); f.dispatch.mockClear()
    await act(async () => { await expect(previous()).resolves.toBeUndefined() })
    expect(f.listDevices).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
  } finally { f.unmount() }
})
