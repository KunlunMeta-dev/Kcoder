import { expect, test } from 'vitest'
import type { RuntimeDeviceWorkspace, RuntimeWorkListResponse } from '@/types/api'
import { mergePartialRuntimeWork, shouldRetainArchivedRuntimeTask } from './partialRuntimeWork'

function work(deviceId: string, workspacePath: string, taskId: string): RuntimeDeviceWorkspace {
  return {
    deviceId,
    workspacePath,
    available: true,
    workspaceSource: 'local',
    tasks: [
      {
        taskId,
        title: taskId,
        runtime: 'kcoder',
        workspacePath,
        running: false,
        updatedAt: '2026-09-10T00:00:00Z',
      },
    ],
  }
}
function snapshot(...items: RuntimeDeviceWorkspace[]): RuntimeWorkListResponse {
  return {
    projects: items.map(item => ({
      project: { key: `${item.deviceId}:${item.workspacePath}`, name: item.workspacePath },
      deviceWorkspaces: [item],
    })),
    chats: [],
    totalTasks: items.reduce((sum, item) => sum + item.tasks.length, 0),
  }
}

test('retains unscanned projects while replacing a completely refreshed workspace', () => {
  const current = work('local', '/current', 'old')
  const slow = work('local', '/slow', 'keep')
  const result = mergePartialRuntimeWork(
    snapshot(current, slow),
    snapshot({ ...current, tasks: [] })
  )
  expect(
    result.projects
      .flatMap(project => project.deviceWorkspaces)
      .map(item => item.workspacePath)
      .sort()
  ).toEqual(['/current', '/slow'])
  expect(
    result.projects
      .flatMap(project => project.deviceWorkspaces)
      .flatMap(item => item.tasks)
      .map(task => task.taskId)
  ).toEqual(['keep'])
  expect(result.totalTasks).toBe(1)
})

test('normalizes Windows paths without merging separate targets and clears recovered errors', () => {
  const old = { ...work('first', 'C:\\Project', 'old'), available: false, error: 'offline' }
  const other = work('second', 'C:\\Project', 'other')
  const fresh = work('first', 'c:/Project', 'new')
  const result = mergePartialRuntimeWork(snapshot(old, other), snapshot(fresh))
  const items = result.projects.flatMap(project => project.deviceWorkspaces)
  expect(items).toHaveLength(2)
  expect(items.find(item => item.deviceId === 'first')).toMatchObject({
    available: true,
    tasks: [expect.objectContaining({ taskId: 'new' })],
  })
  expect(items.find(item => item.deviceId === 'first')?.error).toBeFalsy()
  expect(items.find(item => item.deviceId === 'second')?.tasks[0].taskId).toBe('other')
})

test('partial completion order does not reorder existing projects or chat workspaces', () => {
  const a = work('local', '/a', 'a')
  const b = work('local', '/b', 'b')
  const c = work('remote', '/c', 'c')
  let previous = { ...snapshot(a, b, c), chats: [a, b, c] }
  for (const item of [b, a, c]) {
    previous = mergePartialRuntimeWork(previous, { ...snapshot(item), chats: [item] })
    expect(previous.projects.map(project => project.project.name)).toEqual(['/a', '/b', '/c'])
    expect(previous.chats.map(workspace => workspace.workspacePath)).toEqual(['/a', '/b', '/c'])
  }
})

test('final scan retains missing tasks in partial workspaces but removes genuinely absent workspaces', () => {
  const a = work('local', '/a', 'A')
  const b = work('local', '/a', 'B').tasks[0]
  const gone = work('local', '/gone', 'gone')
  let previous = snapshot({ ...a, tasks: [...a.tasks, b] }, gone)
  for (let index = 0; index < 3; index += 1) {
    previous = mergePartialRuntimeWork(
      previous,
      snapshot({ ...a, threadsComplete: false, threadListIssueCount: 2 }),
      false
    )
    expect(previous.projects.map(project => project.project.name)).toEqual(['/a'])
    expect(previous.projects[0].deviceWorkspaces[0].tasks.map(task => task.taskId)).toEqual([
      'A',
      'B',
    ])
    expect(previous.totalTasks).toBe(2)
  }
  const recovered = mergePartialRuntimeWork(
    previous,
    snapshot({ ...a, threadsComplete: true, threadListIssueCount: 0 }),
    false
  )
  expect(recovered.totalTasks).toBe(1)
})

test('progressive partial task merge preserves unknown workspaces and isolates target identities', () => {
  const a = work('local', '/same', 'old')
  const other = work('remote', '/same', 'remote-task')
  const next = { ...work('local', '/same', 'new'), threadsComplete: false }
  const result = mergePartialRuntimeWork(snapshot(a, other), snapshot(next))
  expect(
    result.projects
      .flatMap(project => project.deviceWorkspaces)
      .flatMap(workspace => workspace.tasks)
      .map(task => task.taskId)
  ).toEqual(['old', 'new', 'remote-task'])
})

test('partial absence never releases archive suppression, including addresses without a workspace path', () => {
  const partial = snapshot({ ...work('local', '/a', 'A'), threadsComplete: false })
  expect(
    shouldRetainArchivedRuntimeTask(partial, {
      deviceId: 'local',
      taskId: 'B',
      workspacePath: '/a',
    })
  ).toBe(true)
  expect(shouldRetainArchivedRuntimeTask(partial, { deviceId: 'local', taskId: 'B' })).toBe(true)
  expect(shouldRetainArchivedRuntimeTask(partial, { deviceId: 'remote', taskId: 'B' })).toBe(false)
  const complete = snapshot({ ...work('local', '/a', 'A'), threadsComplete: true })
  expect(
    shouldRetainArchivedRuntimeTask(complete, {
      deviceId: 'local',
      taskId: 'B',
      workspacePath: '/a',
    })
  ).toBe(false)
  expect(
    shouldRetainArchivedRuntimeTask(complete, {
      deviceId: 'local',
      taskId: 'A',
      workspacePath: '/a',
    })
  ).toBe(true)
})
