import { describe, expect, test } from 'vitest'
import {
  parseThreadRunSummary,
  threadRunActivity,
  threadRunSummaryIsActive,
} from '../threadRunSummary'

const idleSummary = {
  mainTurn: 'idle',
  pendingApprovals: 0,
  pendingQuestions: 0,
  activeJobs: 0,
  tasksPending: 0,
  tasksRunning: 0,
  pendingFollowups: 0,
  pendingGoals: 0,
}

describe('parseThreadRunSummary', () => {
  test('accepts a complete summary and keeps explicit nulls as unknown', () => {
    expect(
      parseThreadRunSummary(json({ ...idleSummary, mainTurn: 'running', activeJobs: 2 }))
    ).toEqual({
      ...idleSummary,
      mainTurn: 'running',
      activeJobs: 2,
    })
    expect(
      parseThreadRunSummary(json({ ...idleSummary, pendingApprovals: null, mainTurn: 'unknown' }))
    ).toMatchObject({ pendingApprovals: null, mainTurn: 'unknown' })
  })

  test('rejects malformed summaries instead of inventing counts', () => {
    expect(parseThreadRunSummary(undefined)).toBeUndefined()
    expect(parseThreadRunSummary(json({ mainTurn: 'running' }))).toBeUndefined()
    expect(parseThreadRunSummary(json({ ...idleSummary, mainTurn: 'paused' }))).toBeUndefined()
    expect(parseThreadRunSummary(json({ ...idleSummary, tasksRunning: '2' }))).toBeUndefined()
  })
})

describe('threadRunActivity', () => {
  test('prefers the actionable wait over a running main turn', () => {
    expect(
      threadRunActivity(
        'running',
        parseThreadRunSummary(json({ ...idleSummary, mainTurn: 'running', pendingApprovals: 1 }))
      )
    ).toBe('waiting_approval')
    expect(
      threadRunActivity(
        'running',
        parseThreadRunSummary(json({ ...idleSummary, mainTurn: 'running', pendingQuestions: 2 }))
      )
    ).toBe('waiting_answer')
    expect(
      threadRunActivity(
        'running',
        parseThreadRunSummary(json({ ...idleSummary, mainTurn: 'running' }))
      )
    ).toBe('running')
  })

  test('separates background work and pending delivery from the main turn', () => {
    expect(
      threadRunActivity('idle', parseThreadRunSummary(json({ ...idleSummary, activeJobs: 1 })))
    ).toBe('background')
    expect(
      threadRunActivity('idle', parseThreadRunSummary(json({ ...idleSummary, tasksRunning: 1 })))
    ).toBe('background')
    expect(
      threadRunActivity('idle', parseThreadRunSummary(json({ ...idleSummary, tasksPending: 1 })))
    ).toBe('background')
    expect(
      threadRunActivity('idle', parseThreadRunSummary(json({ ...idleSummary, pendingGoals: 1 })))
    ).toBe('background')
    expect(
      threadRunActivity(
        'idle',
        parseThreadRunSummary(json({ ...idleSummary, pendingFollowups: 3 }))
      )
    ).toBe('aggregating')
    expect(threadRunActivity('idle', parseThreadRunSummary(json(idleSummary)))).toBe('idle')
  })

  test('never reports a confident idle while a fact is unreadable', () => {
    expect(
      threadRunActivity(
        'idle',
        parseThreadRunSummary(json({ ...idleSummary, pendingFollowups: null }))
      )
    ).toBe('unknown')
    expect(
      threadRunActivity(
        'idle',
        parseThreadRunSummary(json({ ...idleSummary, mainTurn: 'unknown' }))
      )
    ).toBe('unknown')
  })

  test('falls back to the coarse status of a server without the run summary', () => {
    expect(threadRunActivity('running', undefined)).toBe('running')
    expect(threadRunActivity('waiting_for_approval', undefined)).toBe('waiting_approval')
    expect(threadRunActivity('waiting_for_answer', undefined)).toBe('waiting_answer')
    expect(threadRunActivity('background', undefined)).toBe('background')
    expect(threadRunActivity('aggregating', undefined)).toBe('aggregating')
    expect(threadRunActivity('failed', undefined)).toBe('failed')
    expect(threadRunActivity('unknown', undefined)).toBe('unknown')
    expect(threadRunActivity('idle', undefined)).toBe('idle')
    expect(threadRunActivity(undefined, undefined)).toBe('unknown')
  })
})

describe('threadRunSummaryIsActive', () => {
  test('only states with outstanding server work count as active', () => {
    expect(
      ['running', 'waiting_approval', 'waiting_answer', 'background', 'aggregating'].map(activity =>
        threadRunSummaryIsActive(activity as never)
      )
    ).toEqual([true, true, true, true, true])
    expect(
      ['idle', 'failed', 'unknown'].map(activity => threadRunSummaryIsActive(activity as never))
    ).toEqual([false, false, false])
  })
})

function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

test('keeps absent/null/recent failure distinct without carrying raw exception fields', () => {
  expect(parseThreadRunSummary(idleSummary)?.recentError).toBeUndefined()
  expect(parseThreadRunSummary({ ...idleSummary, recentError: null })?.recentError).toBeNull()
  const safe = {
    turnId: 'turn-2',
    attemptId: 'turn-2-retry',
    kind: 'failed',
    source: 'provider',
    category: 'authentication',
    atMs: 1700000000000,
  }
  const parsed = parseThreadRunSummary({
    ...idleSummary,
    recentError: { ...safe, error: 'private prompt', headers: { authorization: 'secret' } },
  })
  expect(parsed?.recentError).toEqual(safe)
  expect(JSON.stringify(parsed)).not.toContain('secret')
  expect(
    parseThreadRunSummary({
      ...idleSummary,
      recentError: { ...safe, category: 'raw-provider-error-text' },
    })?.recentError
  ).toBeUndefined()
})

test('non-resident error-only snapshots are not an ongoing synchronization', () => {
  const summary = parseThreadRunSummary({
    mainTurn: 'unknown', pendingApprovals: null, pendingQuestions: null,
    activeJobs: null, tasksPending: null, tasksRunning: null,
    pendingFollowups: null, pendingGoals: null,
  })
  expect(threadRunActivity('idle', summary)).toBe('idle')
  expect(threadRunActivity('running', summary)).toBe('running')
  expect(threadRunActivity('unknown', summary)).toBe('unknown')
  expect(threadRunActivity('idle', { ...idleSummary, pendingApprovals: null } as never)).toBe('unknown')
})
