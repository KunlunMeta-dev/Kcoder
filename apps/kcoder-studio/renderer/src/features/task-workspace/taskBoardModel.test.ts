import { describe, expect, test } from 'vitest'
import type { RuntimeTaskSummary } from '@/types/api'
import { taskBoardChoiceKey, taskBoardLanes, taskBoardState, taskBoardUpdatedAt, type TaskBoardObservation } from './taskBoardModel'
const task: RuntimeTaskSummary = {
  taskId: 'original',
  threadId: 'original-thread',
  title: 'Task',
  workspacePath: '/owned',
  runtime: 'kcoder',
  runActivity: 'idle',
  turnStatus: 'completed',
}
const observed = (
  patch: Partial<RuntimeTaskSummary> = {},
  stale = false
): TaskBoardObservation => ({ task: { ...task, ...patch }, stale, targetLabel: 'Original target' })
describe('read-only board native status projection', () => {
  test('business records keep their own identity and never infer completion from a reply', () => {
    const work = { workId: 'work-1', threadId: 'original-thread', phase: 'completed',
      freshness: 'partial', revision: 1, requirementsRevision: 1 }
    const previous = observed({ goalStatusObservation: { availability: 'available', status: 'complete' } })
    expect(taskBoardState({ ...previous, work }).lane).toBe('unknown')
    expect(taskBoardState({ ...previous, work: { ...work, freshness: 'current' } }).lane).toBe('unknown')
    expect(taskBoardState({ ...previous, workScanIncomplete: true }).lane).toBe('unknown')
    expect(taskBoardState({ ...previous, work: { ...work, phase: 'stopped', freshness: 'current' } }))
      .toMatchObject({ lane: 'stopped', statusLabel: 'workStopped' })
    expect(taskBoardChoiceKey({ threadId: 'original-thread', workId: 'work-1' }))
      .not.toBe(taskBoardChoiceKey({ threadId: 'original-thread', workId: 'work-2' }))
  })
  test('does not complete background work or pending confirmations just because the main turn completed', () => {
    expect(taskBoardState(observed({ runActivity: 'background' })).lane).toBe('background')
    expect(taskBoardState(observed({ runActivity: 'aggregating' })).lane).toBe('active')
    expect(taskBoardState(observed({ runActivity: 'waiting_approval' })).lane).toBe('waiting')
    expect(taskBoardState(observed({ runActivity: 'waiting_answer' })).lane).toBe('waiting')
  })
  test('stale, optimistic, unknown and older unobserved states stay explicitly unknown', () => {
    expect(taskBoardState(observed({}, true)).lane).toBe('unknown')
    expect(taskBoardState(observed({ optimistic: true })).lane).toBe('unknown')
    expect(taskBoardState(observed({ runActivity: 'unknown' })).lane).toBe('unknown')
    expect(taskBoardState(observed({ runActivity: undefined, running: false })).lane).toBe(
      'unknown'
    )
    expect(taskBoardState()).toEqual({ lane: 'unknown', hint: 'syncNeeded' })
  })
  test('separates confirmed completion from idle, interrupted and failed executions', () => {
    expect(taskBoardState(observed({
      goalStatusObservation: { availability: 'available', status: null },
    })).lane).toBe('completed')
    expect(taskBoardState(observed({ turnStatus: null })).lane).toBe('unknown')
    expect(
      taskBoardState(
        observed({
          turnStatus: null,
          runSummary: {
            mainTurn: 'idle',
            recentError: null,
            pendingApprovals: 0,
            pendingQuestions: 0,
            activeJobs: 0,
            tasksPending: 0,
            tasksRunning: 0,
            pendingFollowups: 0,
            pendingGoals: 0,
          },
        })
      ).lane
    ).toBe('waiting')
    expect(taskBoardState(observed({ turnStatus: 'interrupted' }))).toEqual({
      lane: 'stopped',
      hint: 'interrupted',
    })
    expect(taskBoardState(observed({ turnStatus: 'failed' }))).toEqual({
      lane: 'stopped',
      hint: 'failed',
    })
  })
  test('a finished turn does not complete an unfinished or unknown goal', () => {
    const expected = {
      paused: 'paused',
      blocked: 'waiting',
      usageLimited: 'waiting',
      budgetLimited: 'waiting',
      cancelled: 'stopped',
    } as const
    for (const [goalStatus, lane] of Object.entries(expected)) {
      expect(
        taskBoardState(observed({ goalStatus: goalStatus as RuntimeTaskSummary['goalStatus'] })).lane
      ).toBe(lane)
    }
    expect(taskBoardState(observed({ goalStatus: 'active' })).lane).toBe('unknown')
    expect(
      taskBoardState(observed({ goalStatus: 'future' as RuntimeTaskSummary['goalStatus'] })).lane
    ).toBe('unknown')
    expect(taskBoardState(observed({ goalStatus: 'complete' })).lane).toBe('unknown')
    expect(taskBoardState(observed({
      goalStatusObservation: { availability: 'available', status: 'complete' },
    })).lane).toBe('completed')
    expect(taskBoardState(observed({ goalStatus: 'active', runActivity: 'running' })).lane).toBe(
      'active'
    )
    expect(taskBoardState(observed({ goalStatus: 'active', turnStatus: 'failed' })).lane).toBe(
      'stopped'
    )
  })
  test('missing, unverified or unavailable Goal observations cannot complete a task', () => {
    expect(taskBoardState(observed()))
      .toEqual({ lane: 'unknown', hint: 'replyCompletedGoalUnknown', statusLabel: 'replyCompleted' })
    expect(taskBoardState(observed({ goalStatusObservation: { availability: 'unavailable' } })))
      .toEqual({ lane: 'unknown', hint: 'replyCompletedGoalUnknown', statusLabel: 'replyCompleted' })
    expect(
      taskBoardState(observed({ goalStatusObservation: { availability: 'future' } as never })).lane
    ).toBe('unknown')
    expect(
      taskBoardState(observed({ goalStatusObservation: { availability: 'available', status: null } })).lane
    ).toBe('completed')
    expect(
      taskBoardState(observed({ goalStatusObservation: { availability: 'available', status: 'active' } })).lane
    ).toBe('unknown')
  })
  test('latest committed completion outranks an older remembered error', () => {
    expect(
      taskBoardState(
        observed({
          goalStatusObservation: { availability: 'available', status: null },
          runSummary: {
            mainTurn: 'idle',
            latestTurnStatus: 'completed',
            recentError: {
              turnId: 'turn-1',
              kind: 'failed',
              source: 'execution',
              category: 'execution',
              atMs: 1,
            },
            pendingApprovals: 0,
            pendingQuestions: 0,
            activeJobs: 0,
            tasksPending: 0,
            tasksRunning: 0,
            pendingFollowups: 0,
            pendingGoals: 0,
          },
        })
      ).lane
    ).toBe('completed')
  })
  test('a known failure remains visible when an active goal has no later completed turn', () => {
    expect(
      taskBoardState(
        observed({
          goalStatus: 'active',
          turnStatus: null,
          runSummary: {
            mainTurn: 'idle',
            recentError: {
              turnId: 'turn-1',
              kind: 'failed',
              source: 'execution',
              category: 'execution',
              atMs: 1,
            },
            pendingApprovals: 0,
            pendingQuestions: 0,
            activeJobs: 0,
            tasksPending: 0,
            tasksRunning: 0,
            pendingFollowups: 0,
            pendingGoals: 0,
          },
        })
      )
    ).toEqual({ lane: 'stopped', hint: 'failed' })
  })
  test('does not turn absent confirmation counts or timestamps into zero or current time', () => {
    expect(
      taskBoardState(observed({ runActivity: 'waiting_approval' })).confirmations
    ).toBeUndefined()
    expect(taskBoardUpdatedAt(null)).toBeUndefined()
    expect(taskBoardUpdatedAt('invalid')).toBeUndefined()
    expect(taskBoardUpdatedAt(0)).toBeUndefined()
    expect(taskBoardUpdatedAt('0')).toBeUndefined()
    expect(taskBoardUpdatedAt('2026-10-29T00:00:00Z')?.toISOString()).toBe(
      '2026-10-29T00:00:00.000Z'
    )
    expect(taskBoardUpdatedAt('1700000001000')?.getTime()).toBe(1700000001000)
  })
})

test('time ranges use local calendar days, include today, and keep unknown times only in All', async () => {
  const { taskBoardMatchesPeriod } = await import('./taskBoardModel')
  const now = new Date(2026, 9, 31, 12, 30)
  const day = (offset: number, hour = 0) => new Date(2026, 9, 31 + offset, hour).toISOString()
  expect(taskBoardMatchesPeriod(day(0), 'today', now)).toBe(true)
  expect(taskBoardMatchesPeriod(day(-1, 23), 'today', now)).toBe(false)
  expect(taskBoardMatchesPeriod(day(-6), '7days', now)).toBe(true)
  expect(taskBoardMatchesPeriod(day(-7, 23), '7days', now)).toBe(false)
  expect(taskBoardMatchesPeriod(day(-29), '30days', now)).toBe(true)
  expect(taskBoardMatchesPeriod(day(-30, 23), '30days', now)).toBe(false)
  expect(taskBoardMatchesPeriod(day(1), '30days', now)).toBe(false)
  expect(taskBoardMatchesPeriod(null, '7days', now)).toBe(false)
  expect(taskBoardMatchesPeriod('invalid', 'all', now)).toBe(true)
})

describe('the six board states (lean plan M1-8)', () => {
  test('every observed fact lands in exactly one of six states or unknown', () => {
    const table: [Partial<RuntimeTaskSummary>, string][] = [
      [{ runActivity: 'running' }, 'active'],
      [{ runActivity: 'aggregating' }, 'active'],
      [{ runActivity: 'waiting_answer' }, 'waiting'],
      [{ runActivity: 'waiting_approval' }, 'waiting'],
      [{ runActivity: 'background' }, 'background'],
      [{ goalStatus: 'paused' }, 'paused'],
      [{ goalStatusObservation: { availability: 'available', status: null } }, 'completed'],
      [{ turnStatus: 'failed' }, 'stopped'],
      [{ goalStatus: 'cancelled' }, 'stopped'],
      [{ runActivity: 'unknown' }, 'unknown'],
    ]
    for (const [summary, lane] of table) {
      expect(taskBoardState(observed(summary)).lane, JSON.stringify(summary)).toBe(lane)
    }
    expect(taskBoardLanes).toEqual([
      'active',
      'waiting',
      'background',
      'paused',
      'completed',
      'stopped',
      'unknown',
    ])
  })
})
