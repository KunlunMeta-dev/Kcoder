import { expect, test } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/api'
import { stampRuntimeWorkSnapshot, updateRuntimeWorkActivity as update } from './runtimeWorkActivity'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'

function fixture(): RuntimeWorkListResponse {
  const task = {
    taskId: 'same',
    workspacePath: 'D:\\project',
    title: 'Keep title',
    runtime: 'kcoder',
    running: false,
    updatedAt: 1000,
    pinned: true,
    pinnedOrder: 2,
    modelSelection: { modelName: 'fixture' },
  }
  const workspace = {
    deviceId: 'one',
    deviceName: 'One',
    available: true,
    workspacePath: 'D:\\project',
    tasks: [task],
  }
  return {
    projects: [
      { project: { id: 1, key: 'one', name: 'Project' }, deviceWorkspaces: [workspace], totalTasks: 1 },
    ],
    chats: [{ ...workspace, deviceId: 'two' }],
    totalTasks: 2,
  }
}
const address = { deviceId: 'one', taskId: 'same', workspacePath: '\\\\?\\D:\\project' }

test('updates only the existing target and preserves metadata and counts', () => {
  const source = fixture()
  const result = update(source, { address, observedAt: 2000, running: true })!
  expect(result.projects[0].deviceWorkspaces[0].tasks[0]).toEqual({
    ...source.projects[0].deviceWorkspaces[0].tasks[0],
    updatedAt: 2000,
    running: true,
  })
  expect(result.chats).toBe(source.chats)
  expect(result.totalTasks).toBe(2)
  expect(source.projects[0].deviceWorkspaces[0].tasks[0].running).toBe(false)
})

test('late acceptance only touches activity time and does not restart a settled task', () => {
  const result = update(fixture(), { address, observedAt: 2000 })!
  expect(result.projects[0].deviceWorkspaces[0].tasks[0]).toMatchObject({
    running: false,
    updatedAt: 2000,
  })
})

test('does not insert missing or removed records', () => {
  const source = fixture()
  expect(
    update(source, { address: { ...address, taskId: 'removed' }, observedAt: 2000, running: true })
  ).toBe(source)
  expect(update(null, { address, observedAt: 2000 })).toBeNull()
})

test('updates chat tasks without moving their project or rewinding activity time', () => {
  const source = fixture()
  const result = update(source, {
    address: { ...address, deviceId: 'two' },
    observedAt: 500,
    running: true,
  })!
  expect(result.projects).toBe(source.projects)
  expect(result.chats[0].tasks[0]).toMatchObject({ updatedAt: 1000, running: true })
})

test('an older list snapshot cannot overwrite newer activity but a fresh scan may reconcile it', () => {
  const active = workbenchReducer(
    { ...initialWorkbenchState, runtimeWork: fixture() },
    {
      type: 'runtime_task_activity',
      activity: { address, observedAt: 2000, revision: 2, running: true },
    }
  )
  const stale = workbenchReducer(active, {
    type: 'runtime_work_refreshed',
    runtimeWork: fixture(),
    activityWatermark: 1,
  })
  expect(stale.runtimeWork!.projects[0].deviceWorkspaces[0].tasks[0]).toMatchObject({
    running: true,
    updatedAt: 2000,
  })
  const fresh = workbenchReducer(stale, {
    type: 'runtime_work_refreshed',
    runtimeWork: fixture(),
    activityWatermark: 2,
  })
  expect(fresh.runtimeWork!.projects[0].deviceWorkspaces[0].tasks[0]).toMatchObject({
    running: false,
    updatedAt: 1000,
  })
})

test('an offline last-good workspace is not marked as a newly read snapshot', () => {
  const active = workbenchReducer({ ...initialWorkbenchState, runtimeWork: fixture() }, {
    type: 'runtime_task_activity', activity: { address, observedAt: 2000, revision: 2, running: true },
  })
  const cached = fixture()
  cached.projects[0].deviceWorkspaces[0].available = false
  const result = workbenchReducer(active, { type: 'runtime_work_refreshed', runtimeWork: stampRuntimeWorkSnapshot(cached, 3) })
  expect(result.runtimeWork!.projects[0].deviceWorkspaces[0].tasks[0]).toMatchObject({ running: true, updatedAt: 2000 })
})
