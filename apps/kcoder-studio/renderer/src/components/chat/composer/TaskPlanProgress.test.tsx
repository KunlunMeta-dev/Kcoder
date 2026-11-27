import type { RuntimePlanEventPayload } from '@/types/api'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ComposerStatusItem, ComposerStatusRegion } from './ComposerStatusRegion'
import { TaskPlanProgress } from './TaskPlanProgress'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'workbench.task_plan_progress') {
        return `${String(options?.current)}/${String(options?.total)}`
      }
      if (key === 'workbench.workspace_tab_plan') return '计划'
      return key
    },
  }),
}))

const activePlan: RuntimePlanEventPayload = {
  plan: [
    { step: 'Inspect current behavior', status: 'inProgress' },
    { step: 'Verify the fix', status: 'pending' },
  ],
}

const completedPlan: RuntimePlanEventPayload = {
  plan: activePlan.plan.map(step => ({ ...step, status: 'completed' })),
}

const nextPlan: RuntimePlanEventPayload = {
  plan: [{ step: 'Continue with a new plan', status: 'inProgress' }],
}

function PlanHarness() {
  const [plan, setPlan] = useState(activePlan)
  const [draft, setDraft] = useState('original draft')

  return (
    <>
      <ComposerStatusRegion>
        <TaskPlanProgress plan={plan} presentation="embedded" />
        <ComposerStatusItem id="other" title="Other status">
          <textarea
            aria-label="Other status draft"
            value={draft}
            onChange={event => setDraft(event.currentTarget.value)}
          />
        </ComposerStatusItem>
      </ComposerStatusRegion>
      <TaskPlanProgress plan={plan} presentation="detail" />
      <button type="button" onClick={() => setPlan(completedPlan)}>
        Complete plan
      </button>
      <button type="button" onClick={() => setPlan(nextPlan)}>
        Start next plan
      </button>
    </>
  )
}

describe('TaskPlanProgress', () => {
  test('bounds the plan detail tooltip to the active composer pane', async () => {
    render(
      <div data-testid="project-chat-composer" data-floating-menu-boundary="true">
        <TaskPlanProgress plan={activePlan} />
      </div>
    )
    const boundary = screen.getByTestId('project-chat-composer')
    boundary.getBoundingClientRect = () =>
      ({ left: 500, right: 640, top: 600, bottom: 700, width: 140, height: 100 }) as DOMRect
    const trigger = screen.getByTestId('runtime-plan-progress-button').parentElement!
    trigger.getBoundingClientRect = () =>
      ({ left: 530, right: 610, top: 650, bottom: 682, width: 80, height: 32 }) as DOMRect
    fireEvent(window, new Event('resize'))

    const tooltip = screen.getByTestId('runtime-plan-popover')
    await waitFor(() => expect(tooltip.style.width).toBe('124px'))
    expect(tooltip).toHaveClass('fixed')
    expect(Number.parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(508)
    expect(Number.parseFloat(tooltip.style.left) + Number.parseFloat(tooltip.style.width)).toBeLessThanOrEqual(632)
  })

  test('hides a completed composer entry while preserving historical detail and sibling state', async () => {
    const user = userEvent.setup()
    render(<PlanHarness />)

    await screen.findByTestId('composer-status-trigger-plan')
    const otherStatus = await screen.findByTestId('composer-status-trigger-other')
    const draft = await screen.findByRole('textbox', { name: 'Other status draft' })
    fireEvent.change(draft, { target: { value: 'keep this draft' } })

    await user.click(screen.getByRole('button', { name: 'Complete plan' }))

    await waitFor(() => {
      expect(screen.queryByTestId('composer-status-trigger-plan')).not.toBeInTheDocument()
      expect(screen.queryByTestId('runtime-plan-progress-button')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('runtime-plan-detail')).toHaveTextContent('Inspect current behavior')
    expect(screen.getByTestId('runtime-plan-detail')).toHaveTextContent('Verify the fix')
    expect(otherStatus).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Other status draft' })).toBe(draft)
    expect(draft).toHaveValue('keep this draft')
  })

  test('shows a later active plan after the previous plan completed', async () => {
    const user = userEvent.setup()
    render(<PlanHarness />)

    await screen.findByTestId('composer-status-trigger-plan')
    await user.click(screen.getByRole('button', { name: 'Complete plan' }))
    await waitFor(() =>
      expect(screen.queryByTestId('composer-status-trigger-plan')).not.toBeInTheDocument()
    )

    await user.click(screen.getByRole('button', { name: 'Start next plan' }))

    const planTrigger = await screen.findByTestId('composer-status-trigger-plan')
    expect(planTrigger).toHaveTextContent('计划 1/1')
    expect(screen.getAllByText('Continue with a new plan').length).toBeGreaterThan(0)
  })

  test('does not register an empty plan as a composer status', async () => {
    render(
      <ComposerStatusRegion>
        <TaskPlanProgress plan={{ plan: [] }} presentation="embedded" />
        <ComposerStatusItem id="other" title="Other status">
          <p>Other status details</p>
        </ComposerStatusItem>
      </ComposerStatusRegion>
    )

    expect(await screen.findByTestId('composer-status-trigger-other')).toBeInTheDocument()
    expect(screen.queryByTestId('composer-status-trigger-plan')).not.toBeInTheDocument()
  })
})
