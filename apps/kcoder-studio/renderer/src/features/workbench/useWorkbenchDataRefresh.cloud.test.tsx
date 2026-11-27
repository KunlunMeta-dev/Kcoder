import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useWorkbenchDataRefresh } from './useWorkbenchDataRefresh'
import { initialWorkbenchState } from './workbenchReducer'
import { EMPTY_RUNTIME_WORK, readCachedDeviceList } from './workbenchCloudStatus'
import { createDevice, createRuntimeWork, deferred } from './WorkbenchProvider.test-support'
import type { DeviceInfo } from '@/types/api'

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })

async function setup(mode: 'full' | 'partial', initialWork: typeof EMPTY_RUNTIME_WORK | null = null) {
  const local = createDevice({ capabilities: [] })
  const fresh = createDevice({ device_id: 'current-cloud-device', device_type: 'remote', is_default: false })
  const stale = createDevice({ device_id: 'retired-cloud-device', device_type: 'remote', is_default: false })
  const localWork = deferred<typeof EMPTY_RUNTIME_WORK>()
  const oldDevices = deferred<DeviceInfo[]>(), manualDevices = deferred<DeviceInfo[]>()
  const oldWork = deferred<typeof EMPTY_RUNTIME_WORK>(), newWork = deferred<typeof EMPTY_RUNTIME_WORK>()
  const dispatch = vi.fn()
  const cloud = {
    listTeams: vi.fn().mockResolvedValue([]),
    listDevices: mode === 'full'
      ? vi.fn().mockReturnValueOnce(oldDevices.promise).mockResolvedValue([fresh])
      : vi.fn().mockResolvedValueOnce([fresh]).mockReturnValueOnce(manualDevices.promise).mockResolvedValue([fresh]),
    listRuntimeWork: vi.fn().mockReturnValueOnce(oldWork.promise).mockReturnValue(newWork.promise),
  }
  const options = {
    user: { id: 9501, user_name: 'cloud-reader', email: 'reader@example.com' },
    state: { ...initialWorkbenchState, devices: [local], runtimeWork: initialWork }, dispatch,
    remoteCacheScope: { targetId: 'test-target', principalId: 'first-account' },
    services: { teamApi: { getDefaultWorkbenchTeam: vi.fn().mockResolvedValue(null) }, cloudBackgroundApi: cloud },
    executorClient: {
      commands: { listDevices: vi.fn().mockResolvedValue([local]) },
      runtime: { listRuntimeWork: vi.fn().mockReturnValueOnce(mode === 'full' ? localWork.promise : Promise.resolve(EMPTY_RUNTIME_WORK)).mockResolvedValue(EMPTY_RUNTIME_WORK) },
    },
  } as unknown as Parameters<typeof useWorkbenchDataRefresh>[0]
  const view = renderHook(props => useWorkbenchDataRefresh(props), { initialProps: options })
  await waitFor(() => expect(dispatch.mock.calls.some(([action]) => action.type === 'bootstrapped')).toBe(true))
  if (mode === 'partial') await waitFor(() => expect(cloud.listDevices).toHaveBeenCalledOnce())
  return { ...view, options, cloud, localWork, oldDevices, manualDevices, oldWork, newWork, dispatch, fresh, stale,
    cleanup: async () => {
      view.unmount()
      await act(async () => {
        localWork.resolve(EMPTY_RUNTIME_WORK); oldDevices.resolve([]); manualDevices.resolve([])
        oldWork.resolve(EMPTY_RUNTIME_WORK); newWork.resolve(EMPTY_RUNTIME_WORK)
      })
    } }
}

for (const mode of ['full', 'partial'] as const) {
  test.each(['user', 'executor', 'api', 'scope', 'unmount'] as const)(
    `${mode} cloud read cannot publish/cache after %s changes, and the new source can start`, async boundary => {
      const f = await setup(mode)
      const readCount = mode === 'full' ? 1 : 2
      const nextCloud = {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([f.fresh]),
        listRuntimeWork: vi.fn().mockReturnValue(f.newWork.promise),
      }
      const writes = vi.spyOn(Storage.prototype, 'setItem')
      try {
        await act(async () => { await f.result.current.refreshDevices() })
        await waitFor(() => expect(f.cloud.listDevices).toHaveBeenCalledTimes(readCount))
        if (boundary === 'unmount') f.unmount()
        else {
          await act(async () => { f.rerender({ ...f.options,
            ...(boundary === 'user' ? { user: { ...f.options.user, id: 9502 } } : {}),
            ...(boundary === 'executor' ? { executorClient: { ...f.options.executorClient } } : {}),
            ...(boundary === 'api' ? { services: { ...f.options.services, cloudBackgroundApi: nextCloud } } : {}),
            ...(boundary === 'scope' ? { remoteCacheScope: { targetId: 'test-target', principalId: 'second-account' } } : {}),
          }) })
          await waitFor(() => expect(boundary === 'api' ? nextCloud.listDevices : f.cloud.listDevices)
            .toHaveBeenCalledTimes(boundary === 'api' ? 1 : readCount + 1))
        }
        const cached = readCachedDeviceList()
        f.dispatch.mockClear()
        writes.mockClear()
        await act(async () => {
          f.oldDevices.resolve([f.stale]); f.manualDevices.resolve([f.stale])
          f.oldWork.resolve(createRuntimeWork()); f.localWork.resolve(EMPTY_RUNTIME_WORK)
        })
        expect(f.dispatch).not.toHaveBeenCalled()
        expect(readCachedDeviceList()).toEqual(cached)
        expect(writes).not.toHaveBeenCalled()
        expect(f.cloud.listDevices).toHaveBeenCalledTimes(readCount + (['user', 'executor', 'scope'].includes(boundary) ? 1 : 0))
      } finally { writes.mockRestore(); await f.cleanup() }
    }
  )

  test.each(['api', 'scope'] as const)(`${mode} cloud read stays retired when %s switches away and back`, async boundary => {
    const f = await setup(mode)
    const otherCloud = {
      listTeams: vi.fn().mockResolvedValue([]), listDevices: vi.fn().mockResolvedValue([f.fresh]),
      listRuntimeWork: vi.fn().mockReturnValue(f.newWork.promise),
    }
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    try {
      await act(async () => { await f.result.current.refreshDevices() })
      await act(async () => { f.rerender({ ...f.options,
        ...(boundary === 'api' ? { services: { ...f.options.services, cloudBackgroundApi: otherCloud } }
          : { remoteCacheScope: { targetId: 'test-target', principalId: 'other-account' } }),
      }) })
      await waitFor(() => expect(boundary === 'api' ? otherCloud.listDevices : f.cloud.listDevices)
        .toHaveBeenCalledTimes(boundary === 'api' ? 1 : mode === 'full' ? 2 : 3))
      await act(async () => { f.rerender(f.options) })
      await waitFor(() => expect(f.cloud.listDevices)
        .toHaveBeenCalledTimes((mode === 'full' ? 1 : 2) + (boundary === 'api' ? 1 : 2)))
      f.dispatch.mockClear(); writes.mockClear()
      await act(async () => {
        f.oldDevices.resolve([f.stale]); f.manualDevices.resolve([f.stale]); f.oldWork.resolve(EMPTY_RUNTIME_WORK)
      })
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(writes).not.toHaveBeenCalled()
    } finally { writes.mockRestore(); await f.cleanup() }
  })
}

test('display-only user metadata changes preserve the current cloud cohort without starting another read', async () => {
  const f = await setup('partial')
  try {
    await act(async () => { f.rerender({ ...f.options, user: { ...f.options.user, user_name: 'updated label' } }) })
    expect(f.cloud.listRuntimeWork).toHaveBeenCalledOnce()
    await act(async () => { f.oldWork.resolve(EMPTY_RUNTIME_WORK) })
    await waitFor(() => expect(f.result.current.cloudWorkStatus.updatedAt).not.toBeNull())
    expect(f.cloud.listDevices).toHaveBeenCalledOnce()
    expect(f.cloud.listRuntimeWork).toHaveBeenCalledOnce()
  } finally { await f.cleanup() }
})

test('an equivalent scope object preserves the current cohort without duplicate directory reads', async () => {
  const f = await setup('partial')
  try {
    for (let i = 0; i < 10; i++) await act(async () => {
      f.rerender({ ...f.options, remoteCacheScope: { ...f.options.remoteCacheScope! } })
    })
    expect({ devices: f.cloud.listDevices.mock.calls.length, teams: f.cloud.listTeams.mock.calls.length,
      work: f.cloud.listRuntimeWork.mock.calls.length }).toEqual({ devices: 1, teams: 1, work: 1 })
    await act(async () => { f.oldWork.resolve(EMPTY_RUNTIME_WORK) })
    await waitFor(() => expect(f.result.current.cloudWorkStatus.updatedAt).not.toBeNull())
  } finally { await f.cleanup() }
})

test('a changed scope principal retires old reads even if its input object is reused', async () => {
  const f = await setup('partial')
  try {
    f.options.remoteCacheScope!.principalId = 'second-account'
    await act(async () => { f.rerender({ ...f.options }) })
    await waitFor(() => expect(f.cloud.listDevices).toHaveBeenCalledTimes(2))
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    try {
      f.dispatch.mockClear()
      await act(async () => { f.oldWork.resolve(createRuntimeWork()) })
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(writes).not.toHaveBeenCalled()
    } finally { writes.mockRestore() }
  } finally { await f.cleanup() }
})

test('switching source does not republish the former user task projection while the new cloud read is pending', async () => {
  const f = await setup('full', createRuntimeWork())
  try {
    await act(async () => { await f.result.current.refreshDevices() })
    f.dispatch.mockClear()
    await act(async () => { f.rerender({ ...f.options, user: { ...f.options.user, id: 9502 } }) })
    await waitFor(() => expect(f.cloud.listDevices).toHaveBeenCalledTimes(2))
    expect(f.dispatch.mock.calls.some(([action]) => action.type === 'runtime_work_refreshed' && action.runtimeWork.totalTasks > 0)).toBe(false)
  } finally { await f.cleanup() }
})

test('archive projection writes the current cloud account namespace after a scope switch', async () => {
  const f = await setup('partial')
  const writes = vi.spyOn(Storage.prototype, 'setItem')
  try {
    await act(async () => { f.rerender({ ...f.options,
      remoteCacheScope: { targetId: 'test-target', principalId: 'second-account' },
    }) })
    await waitFor(() => expect(f.cloud.listDevices).toHaveBeenCalledTimes(2))
    writes.mockClear()
    act(() => f.result.current.markRuntimeTasksArchived([
      { deviceId: 'device-1', workspacePath: '/workspace/project-alpha', taskId: 'confirmed-archived-task' },
    ]))
    expect(writes.mock.calls.map(([key]) => key)).toEqual([
      'kcoder.workbench.remoteRuntimeWork.v2.test-target.second-account',
    ])
  } finally { writes.mockRestore(); await f.cleanup() }
})

test.each(['user', 'executor', 'scope', 'unmount'] as const)('a retained archive projection cannot write after %s retirement', async boundary => {
  const f = await setup('partial'), previous = f.result.current.markRuntimeTasksArchived
  const writes = vi.spyOn(Storage.prototype, 'setItem')
  try {
    if (boundary === 'unmount') f.unmount()
    else {
      await act(async () => { f.rerender({ ...f.options,
        ...(boundary === 'user' ? { user: { ...f.options.user, id: 9502 } } : {}),
        ...(boundary === 'executor' ? { executorClient: { ...f.options.executorClient } } : {}),
        ...(boundary === 'scope' ? { remoteCacheScope: { targetId: 'test-target', principalId: 'second-account' } } : {}),
      }) })
      await waitFor(() => expect(f.cloud.listDevices).toHaveBeenCalledTimes(2))
    }
    writes.mockClear(); f.dispatch.mockClear()
    act(() => previous([{ deviceId: 'device-1', workspacePath: '/workspace/project-alpha', taskId: 'original-archived-task' }]))
    expect(writes).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
  } finally { writes.mockRestore(); await f.cleanup() }
})

test('a retained archive projection stays retired after a scope round trip', async () => {
  const f = await setup('partial'), previous = f.result.current.markRuntimeTasksArchived
  const writes = vi.spyOn(Storage.prototype, 'setItem')
  try {
    await act(async () => { f.rerender({ ...f.options,
      remoteCacheScope: { targetId: 'test-target', principalId: 'other-account' },
    }) })
    await waitFor(() => expect(f.cloud.listDevices).toHaveBeenCalledTimes(2))
    await act(async () => { f.rerender(f.options) })
    await waitFor(() => expect(f.cloud.listDevices).toHaveBeenCalledTimes(3))
    writes.mockClear(); f.dispatch.mockClear()
    act(() => previous([{ deviceId: 'device-1', workspacePath: '/workspace/project-alpha', taskId: 'original-archived-task' }]))
    expect(writes).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
  } finally { writes.mockRestore(); await f.cleanup() }
})

test('an API route only change preserves archive acknowledgements for the unchanged data owner', async () => {
  const f = await setup('partial'), previous = f.result.current.markRuntimeTasksArchived
  const writes = vi.spyOn(Storage.prototype, 'setItem')
  const nextCloud = { listDevices: vi.fn().mockResolvedValue([f.fresh]), listRuntimeWork: vi.fn().mockReturnValue(f.newWork.promise) }
  try {
    await act(async () => { f.rerender({ ...f.options, services: { ...f.options.services, cloudBackgroundApi: nextCloud } }) })
    await waitFor(() => expect(nextCloud.listDevices).toHaveBeenCalledOnce())
    writes.mockClear(); f.dispatch.mockClear()
    act(() => previous([{ deviceId: 'device-1', workspacePath: '/workspace/project-alpha', taskId: 'confirmed-archived-task' }]))
    expect(writes.mock.calls.map(([key]) => key)).toEqual(['kcoder.workbench.remoteRuntimeWork.v2.test-target.first-account'])
    expect(f.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'runtime_tasks_archived' }))
  } finally { writes.mockRestore(); await f.cleanup() }
})
