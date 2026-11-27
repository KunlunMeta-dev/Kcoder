import { describe, expect, test } from 'vitest'
import type { RuntimeDeviceWorkspace } from '@/types/api'
import {
  hasExpandedRuntimeSidebarTaskItems,
  getNextRuntimeSidebarTaskVisibleLimit,
  getRuntimeSidebarTaskItems,
  getRuntimeTaskAddress,
  getRuntimeTaskRuntimeLabel,
  getVisibleRuntimeSidebarTaskItems,
  hasHiddenRuntimeSidebarTaskItems,
  RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
} from './runtimeTaskSidebarHelpers'
import { resetRuntimeTaskOrderTimes } from '@/features/workbench/runtimeTaskLifecycle/workListProjection'

describe('runtimeTaskSidebarHelpers', () => {
  test('labels KCoder runtime tasks with the product name', () => {
    expect(getRuntimeTaskRuntimeLabel('kcoder')).toBe('KCoder')
  })

  test('sorts runtime task items newest first across workspaces', () => {
    const oldWorkspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: [
        {
          taskId: 'older-running',
          workspacePath: '/workspace/repo',
          title: 'Older running',
          runtime: 'codex',
          running: true,
          completedAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
        {
          taskId: 'newer-idle',
          workspacePath: '/workspace/repo',
          title: 'Newer idle',
          runtime: 'codex',
          running: false,
          completedAt: '2026-06-02T00:00:00.000Z',
          updatedAt: '2026-06-02T00:00:00.000Z',
        },
      ],
    }
    const newWorkspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo/.worktrees/new-task',
      workspaceKind: 'worktree',
      available: true,
      tasks: [
        {
          taskId: 'new-worktree-task',
          workspacePath: '/workspace/repo/.worktrees/new-task',
          title: 'New worktree task',
          runtime: 'codex',
          running: true,
          completedAt: '2026-06-03T00:00:00.000Z',
          updatedAt: '2026-06-03T00:00:00.000Z',
        },
      ],
    }

    expect(
      getRuntimeSidebarTaskItems([oldWorkspace, newWorkspace]).map(item => item.task.taskId)
    ).toEqual(['new-worktree-task', 'newer-idle', 'older-running'])
  })

  test('uses the latest activity when a completed task resumes and updates again', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: [
        {
          taskId: 'running',
          workspacePath: '/workspace/repo',
          title: 'Running',
          runtime: 'codex',
          running: true,
          createdAt: '2026-06-01T00:00:00.000Z',
          completedAt: '2026-06-02T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
        },
        {
          taskId: 'completed',
          workspacePath: '/workspace/repo',
          title: 'Completed',
          runtime: 'codex',
          running: false,
          createdAt: '2026-06-01T00:00:00.000Z',
          completedAt: '2026-06-03T00:00:00.000Z',
          updatedAt: '2026-06-03T00:00:00.000Z',
        },
      ],
    }

    expect(getRuntimeSidebarTaskItems([workspace]).map(item => item.task.taskId)).toEqual([
      'running',
      'completed',
    ])
  })

  test('carries runtime handle into task addresses when present', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: [],
    }
    const address = getRuntimeTaskAddress(workspace, {
      taskId: 'local-visible-task',
      workspacePath: '/workspace/repo',
      title: 'Existing task',
      runtime: 'codex',
      runtimeHandle: {
        threadId: 'provider-session-1',
      },
    })

    expect(address).toEqual({
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      taskId: 'local-visible-task',
      runtimeHandle: {
        threadId: 'provider-session-1',
      },
    })
  })

  test('uses a chat task path when its grouping workspace is a git worktree', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/worktrees/277/repo',
      available: true,
      tasks: [],
    }

    expect(
      getRuntimeTaskAddress(workspace, {
        taskId: 'standalone-chat',
        workspacePath: '/home/user/Documents/Codex/standalone-chat',
        title: 'Standalone chat',
        runtime: 'codex',
      })
    ).toMatchObject({
      deviceId: 'device-1',
      taskId: 'standalone-chat',
      workspacePath: '/home/user/Documents/Codex/standalone-chat',
    })
  })

  test('reveals project runtime tasks in preview and step increments', () => {
    const items = Array.from({ length: 26 }, (_, index) => ({
      workspace: {
        deviceId: 'device-1',
        workspacePath: '/workspace/repo',
        available: true,
        tasks: [],
      },
      task: {
        taskId: `task-${index + 1}`,
        workspacePath: '/workspace/repo',
        title: `Task ${index + 1}`,
        runtime: 'codex',
      },
    }))

    expect(getVisibleRuntimeSidebarTaskItems(items)).toHaveLength(
      RUNTIME_PROJECT_TASK_PREVIEW_LIMIT
    )
    expect(hasHiddenRuntimeSidebarTaskItems(items)).toBe(true)

    const firstExpandedLimit = getNextRuntimeSidebarTaskVisibleLimit(
      RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
      items.length
    )
    expect(firstExpandedLimit).toBe(15)
    expect(getVisibleRuntimeSidebarTaskItems(items, firstExpandedLimit)).toHaveLength(15)
    expect(hasHiddenRuntimeSidebarTaskItems(items, firstExpandedLimit)).toBe(true)

    const secondExpandedLimit = getNextRuntimeSidebarTaskVisibleLimit(
      firstExpandedLimit,
      items.length
    )
    expect(secondExpandedLimit).toBe(25)
    expect(getVisibleRuntimeSidebarTaskItems(items, secondExpandedLimit)).toHaveLength(25)
    expect(hasHiddenRuntimeSidebarTaskItems(items, secondExpandedLimit)).toBe(true)

    const finalExpandedLimit = getNextRuntimeSidebarTaskVisibleLimit(
      secondExpandedLimit,
      items.length
    )
    expect(finalExpandedLimit).toBe(26)
    expect(getVisibleRuntimeSidebarTaskItems(items, finalExpandedLimit)).toHaveLength(26)
    expect(hasHiddenRuntimeSidebarTaskItems(items, finalExpandedLimit)).toBe(false)
  })

  test('keeps pinned project runtime tasks out of the collapsed task count', () => {
    const items = Array.from({ length: 7 }, (_, index) => ({
      workspace: {
        deviceId: 'device-1',
        workspacePath: '/workspace/repo',
        available: true,
        tasks: [],
      },
      task: {
        taskId: `task-${index + 1}`,
        workspacePath: '/workspace/repo',
        title: `Task ${index + 1}`,
        runtime: 'codex',
      },
      pinned: index < 2,
    }))

    expect(getVisibleRuntimeSidebarTaskItems(items).map(item => item.task.taskId)).toEqual([
      'task-1',
      'task-2',
      'task-3',
      'task-4',
      'task-5',
      'task-6',
      'task-7',
    ])
    expect(hasHiddenRuntimeSidebarTaskItems(items)).toBe(false)
    expect(hasExpandedRuntimeSidebarTaskItems(items)).toBe(false)
  })
})

describe('sidebar order while tasks run', () => {
  const workspace = (tasks: Array<Record<string, unknown>>) =>
    [
      { deviceId: 'order-device', workspacePath: '/w', tasks },
    ] as unknown as RuntimeDeviceWorkspace[]
  const order = (tasks: Array<Record<string, unknown>>) =>
    getRuntimeSidebarTaskItems(workspace(tasks)).map(item => item.task.taskId)

  test('streamed updates do not move a running task; it re-sorts once it stops', () => {
    resetRuntimeTaskOrderTimes()
    const older = { taskId: 'older', updatedAt: '2026-11-04T10:00:00Z', running: true }
    const newer = { taskId: 'newer', updatedAt: '2026-11-04T10:05:00Z' }
    expect(order([older, newer])).toEqual(['newer', 'older'])
    // The running task streams an update that is newer than every other task.
    expect(order([{ ...older, updatedAt: '2026-11-04T10:10:00Z' }, newer])).toEqual([
      'newer',
      'older',
    ])
    // Once it finishes, its real time applies.
    expect(
      order([{ ...older, running: false, completedAt: '2026-11-04T10:11:00Z' }, newer])
    ).toEqual(['older', 'newer'])
  })
})
