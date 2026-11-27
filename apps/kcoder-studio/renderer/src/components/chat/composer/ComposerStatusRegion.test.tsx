import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  ComposerStatusItem,
  ComposerStatusNotice,
  ComposerStatusRegion,
} from './ComposerStatusRegion'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${String(values.count ?? '')}` : key,
  }),
}))

test('renders no status surface when there are no registered items', () => {
  render(
    <ComposerStatusRegion>
      <div data-testid="composer-content">Composer</div>
    </ComposerStatusRegion>
  )

  expect(screen.getByTestId('composer-content')).toBeInTheDocument()
  expect(screen.queryByTestId('composer-status-region')).not.toBeInTheDocument()
  expect(screen.queryByRole('group', { name: 'composer_status.title' })).not.toBeInTheDocument()
})

test('stacks panels upward in opening order above the bottom row and closes them independently', async () => {
  render(
    <ComposerStatusRegion>
      <ComposerStatusItem id="first" title="First" summary="First summary">
        <p>First detail</p>
      </ComposerStatusItem>
      <ComposerStatusItem id="second" title="Second">
        <p>Second detail</p>
      </ComposerStatusItem>
    </ComposerStatusRegion>
  )

  const firstTrigger = await screen.findByRole('button', { name: /First/ })
  const secondTrigger = screen.getByRole('button', { name: /Second/ })
  const firstPanel = screen.getByTestId('composer-status-content-first')
  const secondPanel = screen.getByTestId('composer-status-content-second')

  expect(firstTrigger).toHaveAttribute('aria-expanded', 'true')
  expect(secondTrigger).toHaveAttribute('aria-expanded', 'true')
  expect(firstPanel).not.toHaveAttribute('hidden')
  expect(secondPanel).not.toHaveAttribute('hidden')

  const details = screen.getByTestId('composer-status-details')
  expect([...details.querySelectorAll('section:not([hidden])')]).toEqual([secondPanel, firstPanel])
  const row = screen.getByTestId('composer-status-row')
  expect(details.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'composer_status.closeDetails' })).not.toBeInTheDocument()
  expect(secondPanel).toHaveAccessibleName('Second')
  secondTrigger.focus()
  fireEvent.click(secondTrigger)
  expect(secondTrigger).toHaveAttribute('aria-expanded', 'false')
  expect(secondTrigger).toHaveFocus()
  expect(firstPanel).not.toHaveAttribute('hidden')
  fireEvent.click(secondTrigger)
  fireEvent.click(firstTrigger)
  fireEvent.click(firstTrigger)
  expect([...details.querySelectorAll('section:not([hidden])')]).toEqual([firstPanel, secondPanel])
})

test('keeps an answer draft mounted when switching between status items', async () => {
  render(
    <ComposerStatusRegion>
      <ComposerStatusItem id="questions" title="Questions">
        <label>
          Answer
          <input aria-label="Answer draft" defaultValue="initial" />
        </label>
      </ComposerStatusItem>
      <ComposerStatusItem id="queue" title="Message queue">
        <label>
          Queued message
          <input aria-label="Queue draft" defaultValue="queued" />
        </label>
      </ComposerStatusItem>
    </ComposerStatusRegion>
  )

  const questionsTrigger = await screen.findByRole('button', { name: /Questions/ })
  const queueTrigger = screen.getByRole('button', { name: /Message queue/ })
  const answerDraft = screen.getByRole('textbox', { name: 'Answer draft' })
  fireEvent.change(answerDraft, { target: { value: 'unsent answer' } })
  expect(queueTrigger).toHaveAttribute('aria-expanded', 'true')

  expect(screen.getByTestId('composer-status-content-questions')).not.toHaveAttribute('hidden')
  expect(answerDraft).toHaveValue('unsent answer')
  expect(document.querySelector('[aria-label="Answer draft"]')).toBe(answerDraft)

  fireEvent.click(questionsTrigger)
  expect(screen.getByTestId('composer-status-content-questions')).toHaveAttribute('hidden')
  fireEvent.click(questionsTrigger)
  expect(screen.getByTestId('composer-status-content-questions')).not.toHaveAttribute('hidden')
  expect(screen.getByRole('textbox', { name: 'Answer draft' })).toBe(answerDraft)
  expect(answerDraft).toHaveValue('unsent answer')
})

test('Escape closes the active details and returns focus to its trigger', async () => {
  render(
    <ComposerStatusRegion>
      <ComposerStatusItem id="questions" title="Questions">
        <input aria-label="Answer draft" />
      </ComposerStatusItem>
    </ComposerStatusRegion>
  )

  const trigger = await screen.findByRole('button', { name: /Questions/ })
  const draft = screen.getByRole('textbox', { name: 'Answer draft' })
  draft.focus()
  fireEvent.keyDown(draft, { key: 'Escape' })

  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect(trigger).toHaveFocus()
  expect(screen.getByTestId('composer-status-content-questions')).toHaveAttribute('hidden')
})

test('shows bounded labels and counts without copying full descriptions into the row', async () => {
  render(
    <ComposerStatusRegion>
      <ComposerStatusItem
        id="queue"
        title="Message queue"
        label="Send issues 1"
        count={10}
        summary="1 message failed"
        attention
      >
        <p>Queue details</p>
      </ComposerStatusItem>
      <ComposerStatusItem
        id="questions"
        title="Questions"
        count={3}
        statusText="1 awaiting delivery"
        summary="Full delivery details"
      >
        <p>Question details</p>
      </ComposerStatusItem>
    </ComposerStatusRegion>
  )
  const row = await screen.findByTestId('composer-status-row')
  expect(row).toHaveClass('flex-nowrap', 'overflow-x-auto')
  expect(row).toHaveTextContent('Send issues 1')
  expect(row).toHaveTextContent('Questions')
  expect(row).toHaveTextContent('1 awaiting delivery')
  expect(row).not.toHaveTextContent('1 message failed')
  expect(row).not.toHaveTextContent('Full delivery details')
  expect(screen.getByRole('button', { name: 'Send issues 1' })).toHaveAttribute(
    'title',
    'Message queue 10 · 1 message failed'
  )
  expect(
    screen.queryByRole('button', { name: 'composer_status.collapseRegion' })
  ).not.toBeInTheDocument()
})

test('only triggered items appear and retain arrival order across updates and removals', async () => {
  function Status({ showGoal = false, showPlan = false, count = 1 }) {
    return (
      <ComposerStatusRegion>
        {showGoal && (
          <ComposerStatusItem id="goal" title="Goal">
            <p>Goal details</p>
          </ComposerStatusItem>
        )}
        <ComposerStatusItem id="questions" title="Questions" count={count}>
          <p>Question details</p>
        </ComposerStatusItem>
        {showPlan && (
          <ComposerStatusItem id="plan" title="Plan">
            <p>Plan details</p>
          </ComposerStatusItem>
        )}
      </ComposerStatusRegion>
    )
  }
  const { rerender } = render(<Status />)
  const row = await screen.findByTestId('composer-status-row')
  const ids = () =>
    [...row.querySelectorAll<HTMLElement>('[data-status-item]')].map(
      element => element.dataset.statusItem
    )
  expect(ids()).toEqual(['questions'])
  rerender(<Status showGoal />)
  expect(ids()).toEqual(['questions', 'goal'])
  rerender(<Status showGoal showPlan count={2} />)
  expect(ids()).toEqual(['questions', 'goal', 'plan'])
  rerender(<Status showPlan />)
  expect(ids()).toEqual(['questions', 'plan'])
  rerender(<Status showGoal showPlan />)
  expect(ids()).toEqual(['questions', 'plan', 'goal'])
})

test('metadata updates preserve expansion, scroll position, and child input state', async () => {
  function DynamicStatus({ count, summary }: { count: number; summary: string }) {
    return (
      <ComposerStatusRegion ownerKey="task:one">
        <ComposerStatusItem id="questions" title="Questions" count={count} summary={summary}>
          <input aria-label="Saved draft" defaultValue="initial" />
        </ComposerStatusItem>
      </ComposerStatusRegion>
    )
  }

  const { rerender } = render(<DynamicStatus count={1} summary="One pending" />)
  const trigger = await screen.findByRole('button', { name: /Questions/ })
  const panel = screen.getByTestId('composer-status-content-questions')
  const scroll = screen.getByTestId('composer-status-details')
  const draft = screen.getByRole('textbox', { name: 'Saved draft' })
  fireEvent.change(draft, { target: { value: 'answer in progress' } })
  scroll.scrollTop = 47

  rerender(<DynamicStatus count={2} summary="Two pending" />)

  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByTestId('composer-status-content-questions')).toBe(panel)
  expect(scroll.scrollTop).toBe(47)
  expect(screen.getByRole('textbox', { name: 'Saved draft' })).toBe(draft)
  expect(draft).toHaveValue('answer in progress')
})

test('new owners open their statuses without inheriting a previous owner fold', async () => {
  function OwnedStatus({ ownerKey }: { ownerKey: string }) {
    return (
      <ComposerStatusRegion ownerKey={ownerKey}>
        <ComposerStatusItem id="questions" title="Questions">
          <input aria-label="Owned draft" defaultValue="initial" />
        </ComposerStatusItem>
      </ComposerStatusRegion>
    )
  }

  const { rerender } = render(<OwnedStatus ownerKey="device:task:thread-one" />)
  const trigger = await screen.findByRole('button', { name: /Questions/ })
  const draft = screen.getByRole('textbox', { name: 'Owned draft' })
  fireEvent.change(draft, { target: { value: 'keep this draft' } })
  fireEvent.click(trigger)
  expect(trigger).toHaveAttribute('aria-expanded', 'false')

  rerender(<OwnedStatus ownerKey="device:task:thread-two" />)

  expect(await screen.findByRole('button', { name: /Questions/ })).toHaveAttribute(
    'aria-expanded',
    'true'
  )
  expect(screen.getByTestId('composer-status-content-questions')).not.toHaveAttribute('hidden')
  expect(document.querySelector('[aria-label="Owned draft"]')).toBe(draft)
  expect(draft).toHaveValue('keep this draft')
})

test('keeps the external composer draft mounted when status metadata and registrations change', async () => {
  function Harness({ count, showQueue }: { count: number; showQueue: boolean }) {
    return (
      <ComposerStatusRegion ownerKey="task:stable">
        <ComposerStatusItem id="questions" title="Questions" count={count}>
          <p>Question details</p>
        </ComposerStatusItem>
        {showQueue && (
          <ComposerStatusItem id="queue" title="Message queue" count={1}>
            <p>Queue details</p>
          </ComposerStatusItem>
        )}
        <textarea aria-label="Composer draft" defaultValue="initial" />
      </ComposerStatusRegion>
    )
  }

  const { rerender } = render(<Harness count={1} showQueue={false} />)
  const draft = screen.getByRole('textbox', { name: 'Composer draft' })
  fireEvent.change(draft, { target: { value: 'unsent composer text' } })

  rerender(<Harness count={2} showQueue />)
  expect(screen.getByRole('textbox', { name: 'Composer draft' })).toBe(draft)
  expect(draft).toHaveValue('unsent composer text')

  rerender(<Harness count={3} showQueue={false} />)
  expect(screen.getByRole('textbox', { name: 'Composer draft' })).toBe(draft)
  expect(draft).toHaveValue('unsent composer text')
})

test('portals urgent notices before the shared status row', async () => {
  render(
    <ComposerStatusRegion>
      <ComposerStatusNotice>
        <div data-testid="offline-notice">Offline</div>
      </ComposerStatusNotice>
      <ComposerStatusItem id="plan" title="Plan">
        <p>Plan details</p>
      </ComposerStatusItem>
    </ComposerStatusRegion>
  )

  const notice = await screen.findByTestId('offline-notice')
  const statusRegion = await screen.findByTestId('composer-status-region')
  expect(
    notice.parentElement?.compareDocumentPosition(statusRegion) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
})

test('Escape closes the focused panel without closing its siblings', async () => {
  render(
    <ComposerStatusRegion>
      <ComposerStatusItem id="first" title="First">
        <input aria-label="First draft" />
      </ComposerStatusItem>
      <ComposerStatusItem id="second" title="Second">
        <input aria-label="Second draft" />
      </ComposerStatusItem>
    </ComposerStatusRegion>
  )
  const first = await screen.findByRole('button', { name: 'First' })
  const second = screen.getByRole('button', { name: 'Second' })
  const draft = screen.getByRole('textbox', { name: 'First draft' })
  draft.focus()
  fireEvent.keyDown(draft, { key: 'Escape' })
  expect(first).toHaveAttribute('aria-expanded', 'false')
  expect(second).toHaveAttribute('aria-expanded', 'true')
  expect(first).toHaveFocus()
})

test('removes an open item without closing peers and expands a fresh replacement', async () => {
  function Status({ showGoal }: { showGoal: boolean }) {
    return (
      <ComposerStatusRegion>
        {showGoal && (
          <ComposerStatusItem id="goal" title="Goal">
            <p>Goal details</p>
          </ComposerStatusItem>
        )}
        <ComposerStatusItem id="plan" title="Plan">
          <p>Plan details</p>
        </ComposerStatusItem>
      </ComposerStatusRegion>
    )
  }
  const { rerender } = render(<Status showGoal />)
  expect(await screen.findByRole('button', { name: 'Goal' })).toHaveAttribute('aria-expanded', 'true')
  rerender(<Status showGoal={false} />)
  expect(screen.queryByTestId('composer-status-content-goal')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Plan' })).toHaveAttribute('aria-expanded', 'true')
  rerender(<Status showGoal />)
  expect(screen.getByRole('button', { name: 'Goal' })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('button', { name: 'Plan' })).toHaveAttribute('aria-expanded', 'true')
})


test('metadata updates preserve a manual fold while newly arriving siblings open', async () => {
  function Status({ showPlan, count }: { showPlan: boolean; count: number }) {
    return <ComposerStatusRegion>
      <ComposerStatusItem id="questions" title="Questions" count={count}><input aria-label="Saved answer" /></ComposerStatusItem>
      {showPlan && <ComposerStatusItem id="plan" title="Plan"><p>Plan details</p></ComposerStatusItem>}
    </ComposerStatusRegion>
  }
  const { rerender } = render(<Status showPlan={false} count={1} />)
  const questions = await screen.findByRole('button', { name: /Questions/ })
  const draft = screen.getByRole('textbox', { name: 'Saved answer' })
  fireEvent.change(draft, { target: { value: 'keep the answer' } })
  fireEvent.click(questions)
  rerender(<Status showPlan count={2} />)
  expect(questions).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByRole('button', { name: 'Plan' })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByTestId('composer-status-content-questions')).toHaveAttribute('hidden')
  expect(document.querySelector('[aria-label="Saved answer"]')).toBe(draft)
  expect(draft).toHaveValue('keep the answer')
  const row = screen.getByTestId('composer-status-row')
  expect(row).toHaveClass('flex-nowrap', 'overflow-x-auto')
  for (const item of row.querySelectorAll('[data-status-item]')) expect(item).toHaveClass('shrink-0')
})

test('a dismissible item shows a labelled close control that calls its owner', async () => {
  const onDismiss = vi.fn()
  render(
    <ComposerStatusRegion>
      <ComposerStatusItem id="workflows" title="Workflows" onDismiss={onDismiss} dismissLabel="Dismiss workflows">
        <div>cards</div>
      </ComposerStatusItem>
    </ComposerStatusRegion>
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss workflows' }))
  expect(onDismiss).toHaveBeenCalledOnce()
})
