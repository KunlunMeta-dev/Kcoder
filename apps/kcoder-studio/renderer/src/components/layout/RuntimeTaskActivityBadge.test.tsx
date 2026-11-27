import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RuntimeTaskActivityBadge } from './RuntimeTaskActivityBadge'
import type { ThreadRunActivity } from '@/kcoder/threadRunSummary'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)
test.each([
  'running',
  'background',
  'waiting_approval',
  'waiting_answer',
  'aggregating',
  'unknown',
] as ThreadRunActivity[])('exposes distinct %s activity text and icon semantics', activity => {
  render(<RuntimeTaskActivityBadge taskId="test" activity={activity} running />)
  const badge = screen.getByTestId('runtime-task-activity-test')
  expect(badge).toHaveAttribute('data-activity', activity)
  expect(badge).toHaveTextContent(`workbench.runtime_activity.${activity}`)
  expect(badge.querySelector('.animate-spin') !== null).toBe(activity === 'running')
})
test('recent failure is a separate historical marker and never prints raw exception fields', () => {
  render(
    <RuntimeTaskActivityBadge
      taskId="test"
      running={false}
      activity="idle"
      summary={{
        mainTurn: 'idle',
        pendingApprovals: 0,
        pendingQuestions: 0,
        activeJobs: 0,
        tasksPending: 0,
        tasksRunning: 0,
        pendingFollowups: 0,
        pendingGoals: 0,
        recentError: {
          turnId: 'turn-1',
          kind: 'failed',
          source: 'provider',
          category: 'network',
          atMs: 1,
        },
      }}
    />
  )
  expect(screen.getByTestId('runtime-task-recent-error-test')).toHaveTextContent(
    'workbench.runtime_activity.recent_failed'
  )
  expect(screen.queryByTestId('runtime-task-activity-test')).not.toBeInTheDocument()
})

test('unknown execution remains visibly unknown even without an active local turn', () => {
  render(<RuntimeTaskActivityBadge taskId="unknown" running={false} activity="unknown" />)
  expect(screen.getByTestId('runtime-task-activity-unknown')).toHaveTextContent(
    'workbench.runtime_activity.unknown'
  )
})
