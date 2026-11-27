import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useWorkbenchDataRefresh } from './useWorkbenchDataRefresh'
import { initialWorkbenchState } from './workbenchReducer'
import type { RuntimeDeviceWorkspace, RuntimeWorkListResponse } from '@/types/api'
import { notifyRuntimeWorkChanged } from '@/kcoder/runtimeWorkEvents'

function snapshot(
  ids: string[],
  partial = false,
  includeMissingWorkspace = false
): RuntimeWorkListResponse {
  const workspace: RuntimeDeviceWorkspace = {
    deviceId: 'local',
    workspacePath: '/a',
    available: true,
    workspaceSource: 'local',
    threadsComplete: !partial,
    threadListIssueCount: partial ? 2 : 0,
    tasks: ids.map(taskId => ({
      taskId,
      title: taskId,
      runtime: 'kcoder',
      running: false,
      workspacePath: '/a',
      updatedAt: '2026-09-10T00:00:00Z',
    })),
  }
  return {
    projects: [
      { project: { key: 'a', name: 'A' }, deviceWorkspaces: [workspace] },
      ...(includeMissingWorkspace
        ? [
            {
              project: { key: 'gone', name: 'Gone' },
              deviceWorkspaces: [{ ...workspace, workspacePath: '/gone', tasks: [] }],
            },
          ]
        : []),
    ],
    chats: [],
    totalTasks: ids.length,
  }
}

test('event bursts retain one in-flight list read and one trailing refresh, with no work after unmount', async () => {
  const dispatch = vi.fn()
  const listRuntimeWork = vi.fn(async () => snapshot(['original']))
  const options = {
    user: { id: 9301, user_name: 'observer', email: 'observer@example.com' },
    state: { ...initialWorkbenchState, runtimeWork: snapshot(['original']) }, dispatch,
    services: { teamApi: { getDefaultWorkbenchTeam: vi.fn().mockResolvedValue(null) } },
    executorClient: { commands: { listDevices: vi.fn().mockResolvedValue([]) }, runtime: { listRuntimeWork } },
  } as unknown as Parameters<typeof useWorkbenchDataRefresh>[0]
  const { result, unmount } = renderHook(() => useWorkbenchDataRefresh(options))
  try {
    await waitFor(() => expect(dispatch.mock.calls.some(([action]) => action.type === 'runtime_work_refreshed')).toBe(true))
    vi.useFakeTimers()
    listRuntimeWork.mockClear()
    const listDevices = vi.mocked(options.executorClient.commands.listDevices)
    listDevices.mockClear()
    let finish!: (value: RuntimeWorkListResponse) => void
    listRuntimeWork.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    act(() => { for (let i = 0; i < 100; i++) notifyRuntimeWorkChanged() })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(listRuntimeWork).toHaveBeenCalledOnce()
    act(() => { for (let i = 0; i < 100; i++) notifyRuntimeWorkChanged() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(listRuntimeWork).toHaveBeenCalledOnce()
    await act(async () => { finish(snapshot(['updated'])); await vi.advanceTimersByTimeAsync(100) })
    expect(listRuntimeWork).toHaveBeenCalledTimes(2)
    expect(listDevices).not.toHaveBeenCalled()
    await act(async () => { await result.current.refreshWorkLists() })
    expect(listDevices).toHaveBeenCalledTimes(1)
    expect(listRuntimeWork).toHaveBeenCalledTimes(3)
    act(() => { notifyRuntimeWorkChanged(); unmount() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(listRuntimeWork).toHaveBeenCalledTimes(3)
  } finally { unmount(); vi.useRealTimers() }
})

test.each(['scheduled', 'reading'] as const)('display changes preserve the %s work refresh and serialize its trailing read', async phase => {
  const dispatch = vi.fn()
  const listRuntimeWork = vi.fn(async () => snapshot(['original']))
  const options = {
    user: { id: 9302, user_name: 'observer', email: 'observer@example.com' },
    state: { ...initialWorkbenchState, runtimeWork: snapshot(['original']) }, dispatch,
    services: { teamApi: { getDefaultWorkbenchTeam: vi.fn().mockResolvedValue(null) } },
    executorClient: { commands: { listDevices: vi.fn().mockResolvedValue([]) }, runtime: { listRuntimeWork } },
  } as unknown as Parameters<typeof useWorkbenchDataRefresh>[0]
  const { rerender, unmount } = renderHook(props => useWorkbenchDataRefresh(props), { initialProps: options })
  let finish: ((value: RuntimeWorkListResponse) => void) | undefined
  try {
    await waitFor(() => expect(dispatch.mock.calls.some(([action]) => action.type === 'runtime_work_refreshed')).toBe(true))
    vi.useFakeTimers()
    listRuntimeWork.mockClear()
    const listDevices = vi.mocked(options.executorClient.commands.listDevices)
    listDevices.mockClear()
    listRuntimeWork.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    act(() => { notifyRuntimeWorkChanged() })
    if (phase === 'reading') await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    const latestState = { ...options.state, projects: [...options.state.projects], standaloneDeviceId: 'next' }
    act(() => { rerender({ ...options, state: latestState }) })
    // A changed callback must neither discard scheduled work nor start a second scan.
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(listRuntimeWork).toHaveBeenCalledTimes(1)
    act(() => { for (let i = 0; i < 100; i++) notifyRuntimeWorkChanged() })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(listRuntimeWork).toHaveBeenCalledTimes(1)
    await act(async () => { finish?.(snapshot(['updated'])); await vi.advanceTimersByTimeAsync(100) })
    expect(listRuntimeWork).toHaveBeenCalledTimes(2)
    expect(listDevices).not.toHaveBeenCalled()
    expect(dispatch.mock.calls.filter(([action]) => action.type === 'runtime_work_refreshed').at(-1)?.[0].runtimeWork)
      .toMatchObject({ totalTasks: 1 })
    expect(dispatch.mock.calls.some(([action]) => action.type === 'lists_refreshed')).toBe(false)
  } finally { unmount(); finish?.(snapshot(['cleanup'])); vi.useRealTimers() }
})

test.each(['user', 'executor'] as const)(
  'a %s change retires the old observer queue and ignores its late scan',
  async boundary => {
    const dispatch = vi.fn()
    const listRuntimeWork = vi.fn(async () => snapshot(['current']))
    const options = {
      user: { id: 9303, user_name: 'observer', email: 'observer@example.com' },
      state: { ...initialWorkbenchState, runtimeWork: snapshot(['current']) }, dispatch,
      services: { teamApi: { getDefaultWorkbenchTeam: vi.fn().mockResolvedValue(null) } },
      executorClient: { commands: { listDevices: vi.fn().mockResolvedValue([]) }, runtime: { listRuntimeWork } },
    } as unknown as Parameters<typeof useWorkbenchDataRefresh>[0]
    const { rerender, unmount } = renderHook(props => useWorkbenchDataRefresh(props), { initialProps: options })
    let finish: ((value: RuntimeWorkListResponse) => void) | undefined
    try {
      await waitFor(() => expect(dispatch.mock.calls.some(([action]) => action.type === 'runtime_work_refreshed')).toBe(true))
      vi.useFakeTimers()
      listRuntimeWork.mockClear()
      listRuntimeWork.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      act(() => { notifyRuntimeWorkChanged() })
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      expect(listRuntimeWork).toHaveBeenCalledTimes(1)
      act(() => { notifyRuntimeWorkChanged() })
      await act(async () => { rerender({
        ...options,
        ...(boundary === 'user'
          ? { user: { ...options.user, id: 9304 } }
          : { executorClient: { ...options.executorClient } }),
      }) })
      expect(listRuntimeWork).toHaveBeenCalledTimes(2)
      dispatch.mockClear()
      await act(async () => { finish?.(snapshot(['old-owner'])); await vi.advanceTimersByTimeAsync(1000) })
      expect(listRuntimeWork).toHaveBeenCalledTimes(2)
      expect(dispatch).not.toHaveBeenCalled()
      act(() => { notifyRuntimeWorkChanged() })
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      expect(listRuntimeWork).toHaveBeenCalledTimes(3)
      expect(dispatch.mock.calls.some(([action]) => action.type === 'runtime_work_refreshed')).toBe(true)
    } finally { unmount(); finish?.(snapshot(['cleanup'])); vi.useRealTimers() }
  }
)

test.each(['user', 'executor'] as const)(
  'partial refresh does not inherit tasks across %s changes',
  async boundary => {
    for (const failNewBootstrap of [false, true]) {
      const dispatch = vi.fn()
      let phase: 'old' | 'failed' | 'partial' = 'old'
      const listRuntimeWork = vi.fn(
        async (onProgress?: (work: RuntimeWorkListResponse) => void) => {
          if (phase === 'failed') throw new Error('new source temporarily unavailable')
          const work = phase === 'old' ? snapshot(['A', 'B']) : snapshot(['C'], true)
          onProgress?.(work)
          return work
        }
      )
      const executorClient = {
        commands: { listDevices: vi.fn().mockResolvedValue([]) },
        runtime: { listRuntimeWork },
      }
      const options = {
        user: { id: 9101, user_name: 'old-owner', email: 'old@example.com' },
        state: { ...initialWorkbenchState, runtimeWork: snapshot(['A', 'B']) },
        dispatch,
        services: { teamApi: { getDefaultWorkbenchTeam: vi.fn().mockResolvedValue(null) } },
        executorClient,
      } as unknown as Parameters<typeof useWorkbenchDataRefresh>[0]
      const { result, rerender, unmount } = renderHook(props => useWorkbenchDataRefresh(props), {
        initialProps: options,
      })
      try {
        await waitFor(() =>
          expect(
            dispatch.mock.calls.some(([action]) => action.type === 'runtime_work_refreshed')
          ).toBe(true)
        )
        const previousSourceRefresh = result.current.refreshWorkLists
        dispatch.mockClear()
        phase = failNewBootstrap ? 'failed' : 'partial'
        const calls = listRuntimeWork.mock.calls.length
        await act(async () => {
          rerender({
            ...options,
            ...(boundary === 'user'
              ? { user: { ...options.user, id: 9102 } }
              : { executorClient: { ...options.executorClient } }),
          })
        })
        await waitFor(() => expect(listRuntimeWork.mock.calls.length).toBeGreaterThan(calls))
        phase = 'partial'
        await act(async () => {
          await result.current.refreshWorkLists()
        })
        const work = dispatch.mock.calls
          .filter(([action]) => action.type === 'lists_refreshed')
          .at(-1)?.[0].runtimeWork as RuntimeWorkListResponse
        expect(work.projects[0].deviceWorkspaces[0].tasks.map(task => task.taskId)).toEqual(['C'])
        const currentCalls = listRuntimeWork.mock.calls.length
        await act(async () => {
          await previousSourceRefresh()
        })
        expect(listRuntimeWork.mock.calls).toHaveLength(currentCalls)
      } finally {
        unmount()
      }
    }
  }
)

test('refresh hook preserves partial tasks, removes absent final workspaces, and retains archive suppression', async () => {
  const dispatch = vi.fn()
  let response = snapshot(['A', 'B'], false, true)
  const listRuntimeWork = vi.fn(async (onProgress?: (work: RuntimeWorkListResponse) => void) => {
    onProgress?.(response)
    return response
  })
  const options = {
    user: { id: 9001, user_name: 'fixture', email: 'fixture@example.com' },
    state: { ...initialWorkbenchState, runtimeWork: response },
    dispatch,
    services: { teamApi: { getDefaultWorkbenchTeam: vi.fn().mockResolvedValue(null) } },
    executorClient: {
      commands: { listDevices: vi.fn().mockResolvedValue([]) },
      runtime: { listRuntimeWork },
    },
  } as unknown as Parameters<typeof useWorkbenchDataRefresh>[0]
  const { result, unmount } = renderHook(() => useWorkbenchDataRefresh(options))
  const latest = () =>
    dispatch.mock.calls.filter(([action]) => action.type === 'lists_refreshed').at(-1)?.[0]
      .runtimeWork as RuntimeWorkListResponse
  try {
    await waitFor(() =>
      expect(dispatch.mock.calls.some(([action]) => action.type === 'runtime_work_refreshed')).toBe(
        true
      )
    )
    response = snapshot(['A'], true)
    await act(async () => {
      await result.current.refreshWorkLists()
    })
    expect(latest().projects.map(project => project.project.key)).toEqual(['a'])
    expect(latest().projects[0].deviceWorkspaces[0].tasks.map(task => task.taskId)).toEqual([
      'A',
      'B',
    ])
    act(() =>
      result.current.markRuntimeTasksArchived([
        { deviceId: 'local', workspacePath: '/a', taskId: 'B' },
      ])
    )
    for (let index = 0; index < 2; index += 1)
      await act(async () => {
        await result.current.refreshWorkLists()
      })
    response = snapshot(['A', 'B'], true)
    await act(async () => {
      await result.current.refreshWorkLists()
    })
    expect(latest().projects[0].deviceWorkspaces[0].tasks.map(task => task.taskId)).toEqual(['A'])
    response = snapshot(['A'])
    await act(async () => {
      await result.current.refreshWorkLists()
    })
    expect(latest().projects[0].deviceWorkspaces[0].threadsComplete).toBe(true)
  } finally {
    unmount()
  }
})
