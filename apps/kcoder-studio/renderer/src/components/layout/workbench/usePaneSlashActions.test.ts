import { renderHook } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { RuntimeDeviceWorkspace, RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import { usePaneSlashActions } from './usePaneSlashActions'

const actions = vi.hoisted(() => ({
  openStandaloneWorkspace: vi.fn(),
  renameRuntimeTask: vi.fn(),
  selectProjectWorkspace: vi.fn(),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => actions }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const address: RuntimeTaskAddress = { deviceId: 'remote-b', taskId: 'same-task', threadId: 'thread-b' }
function workspace(deviceId: string, id: number, projectId: number | null): RuntimeDeviceWorkspace {
  return {
    id, projectId, deviceId, available: true, workspacePath: `/work/${deviceId}`,
    tasks: [{
      taskId: address.taskId, workspacePath: `/work/${deviceId}`, title: 'Test task', runtime: 'kcoder',
    }],
  }
}

beforeEach(() => vi.clearAllMocks())

test('binds /new and /rename to the current target when task IDs overlap', async () => {
  const runtimeWork: RuntimeWorkListResponse = {
    projects: [
      { project: { id: 11, key: 'a', name: 'A' }, deviceWorkspaces: [workspace('remote-a', 1, 11)] },
      { project: { id: 22, key: 'b', name: 'B' }, deviceWorkspaces: [workspace('remote-b', 2, 22)] },
    ],
    chats: [], totalTasks: 2,
  }
  const { result } = renderHook(() => usePaneSlashActions(address, runtimeWork, 11, true))
  await result.current.commands.find(command => command.id === 'new')?.run?.('')
  await result.current.commands.find(command => command.id === 'rename')?.run?.('Updated title')
  expect(actions.selectProjectWorkspace).toHaveBeenCalledExactlyOnceWith(22, 2)
  expect(actions.renameRuntimeTask).toHaveBeenCalledExactlyOnceWith(
    address, 'Updated title', { throwOnRejection: true }
  )
})

test('keeps a standalone session on its own workspace and hides protected actions', async () => {
  const runtimeWork: RuntimeWorkListResponse = {
    projects: [], chats: [workspace('remote-b', 2, null)], totalTasks: 1,
  }
  const { result } = renderHook(() => usePaneSlashActions(address, runtimeWork, 11, true))
  await result.current.commands.find(command => command.id === 'new')?.run?.('')
  expect(actions.openStandaloneWorkspace).toHaveBeenCalledExactlyOnceWith('remote-b', '/work/remote-b', undefined)
  expect(actions.selectProjectWorkspace).not.toHaveBeenCalled()
  const channelAddress = { ...address, runtimeHandle: { channelTaskSource: 'connector' } }
  expect(renderHook(() => usePaneSlashActions(channelAddress, runtimeWork, 11, true)).result.current.commands).toEqual([])
  expect(renderHook(() => usePaneSlashActions(address, runtimeWork, 11, false)).result.current.commands).toEqual([])
})

test('offers terminal commands only without a desktop equivalent and excludes them from KWorker', () => {
  const source = { ...address, workspacePath: '/work/remote-b' }
  const { result, rerender } = renderHook(({ mode }) =>
    usePaneSlashActions({ ...source, runtimeHandle: { studioWorkMode: mode } }, undefined, undefined, true,
      { isGateway: true }), { initialProps: { mode: 'kcoder' } })
  const commands = result.current.commands
  for (const name of ['spec', 'work', 'roster', 'undo', 'rewind', 'export', 'skill-usage', 'resume']) {
    const command = commands.find(item => item.id === name)
    expect(command?.enabled).toBe(true)
    expect(command?.metaLabel).toBe('workbench.slash_native_meta')
  }
  // Studio-owned and REPL-only commands never fall back to the terminal dialog.
  for (const name of ['learn', 'settings', 'btw', 'permission', 'stop', 'clear', 'quit', 'raw', 'model']) {
    expect(commands.some(command => command.id === name)).toBe(false)
  }
  rerender({ mode: 'kworker' })
  expect(result.current.commands.map(command => command.id)).toEqual(['rename'])
})
