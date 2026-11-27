import { expect, test } from 'vitest'
import type { RuntimeTaskSummary } from '@/types/api'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'

test('list refresh cannot age out an unknown operation, but explicit removal can discard its local record', () => {
  const unknown: RuntimeTaskSummary = {
    taskId: 'original-request',
    workspacePath: '/original',
    title: 'Unconfirmed',
    runtime: 'kcoder',
    optimistic: true,
    status: 'failed',
    updatedAt: Date.now() - 60 * 60 * 1000,
    creationRequest: {
      clientRequestId: 'original-request',
      clientMessageId: 'original-input',
      outcome: 'unknown',
    },
  }
  const rejected = {
    ...unknown,
    taskId: 'rejected-request',
    creationRequest: { ...unknown.creationRequest!, outcome: 'rejected' as const },
  }
  const state = {
    ...initialWorkbenchState,
    runtimeWork: {
      projects: [],
      chats: [
        {
          deviceId: 'original-target',
          workspacePath: '/original',
          available: true,
          tasks: [unknown, rejected],
        },
      ],
      totalTasks: 2,
    },
  }
  const refreshed = workbenchReducer(state, {
    type: 'runtime_work_refreshed',
    runtimeWork: { projects: [], chats: [], totalTasks: 0 },
  })
  expect(refreshed.runtimeWork?.chats[0].tasks).toEqual([unknown])
  const removed = workbenchReducer(refreshed, {
    type: 'runtime_task_optimistic_removed',
    address: {
      deviceId: 'original-target',
      taskId: unknown.taskId,
      workspacePath: '/original',
    },
  })
  expect(removed.runtimeWork?.chats.flatMap(workspace => workspace.tasks)).toEqual([])
})
