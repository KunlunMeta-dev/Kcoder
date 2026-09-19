import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useWorkbenchDataRefresh } from './useWorkbenchDataRefresh'
import { initialWorkbenchState } from './workbenchReducer'
import type { RuntimeDeviceWorkspace, RuntimeWorkListResponse } from '@/types/api'

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
