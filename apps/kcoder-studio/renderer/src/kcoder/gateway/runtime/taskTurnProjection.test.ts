import { expect, test } from 'vitest'
import { taskBoardState } from '@/features/task-workspace/taskBoardModel'
import { projectTaskTurn } from './taskTurnProjection'
import type { GatewayTask } from './contracts'
const task: GatewayTask = {
  serverId: 'local', taskId: 'owned-task', threadId: 'owned-thread', workspacePath: '/owned',
  title: 'Task', runtime: 'kcoder', persisted: true, running: false,
  createdAt: 1, updatedAt: 1, runtimeHandle: { threadId: 'owned-thread' }, runActivity: 'idle',
  runSummary: { mainTurn: 'idle', recentError: null, pendingApprovals: 0, pendingQuestions: 0,
    activeJobs: 0, tasksPending: 0, tasksRunning: 0, pendingFollowups: 0, pendingGoals: 0 },
}
const lane = (value: GatewayTask) => taskBoardState({ task: value, targetLabel: 'Owned', stale: false }).lane

test('a completed reply is retained as a fact without claiming business completion', () => {
  const completed = projectTaskTurn(task, 'completed')
  expect(completed.turnStatus).toBe('completed')
  // The original contract: a finished reply and an unverified Goal cannot
  // establish business completion, so the row stays unconfirmed.
  const state = taskBoardState({ task: completed, targetLabel: 'Owned', stale: false })
  expect(state.lane).toBe('unknown')
  expect(state.statusLabel).toBe('replyCompleted')
  const next = projectTaskTurn(completed, 'inProgress')
  expect(next.completedAt).toBeUndefined()
  expect(next.runSummary?.latestTurnStatus).toBeUndefined()
  expect(lane(next)).toBe('active')
})

test('only a verified Goal completion finishes the row', () => {
  const completed = projectTaskTurn(
    {
      ...task,
      goalStatusObservation: { availability: 'available', status: 'complete' },
    },
    'completed'
  )
  expect(lane(completed)).toBe('completed')
  const active = projectTaskTurn(
    {
      ...task,
      goalStatusObservation: { availability: 'available', status: 'active' },
    },
    'completed'
  )
  expect(lane(active)).toBe('unknown')
})
test('main completion does not erase active jobs or pending confirmations', () => {
  const background = projectTaskTurn({ ...task, runSummary: { ...task.runSummary!, activeJobs: 1 } }, 'completed')
  // M1-8: a finished turn with live background work waits in its own lane.
  expect(lane(background)).toBe('background')
  const approval = projectTaskTurn({ ...task, runSummary: { ...task.runSummary!, pendingApprovals: 1 } }, 'completed')
  expect(lane(approval)).toBe('waiting')
})
test('an owned background job survives completion even on a legacy summary-less server', () => {
  expect(lane(projectTaskTurn({ ...task, runSummary: undefined }, 'completed', true))).toBe('background')
  expect(lane(projectTaskTurn(task, 'failed'))).toBe('stopped')
  expect(lane(projectTaskTurn(task, 'interrupted'))).toBe('stopped')
})
