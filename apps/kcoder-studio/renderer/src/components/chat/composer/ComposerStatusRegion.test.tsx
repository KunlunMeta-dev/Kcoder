import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ComposerStatusItem, ComposerStatusNotice, ComposerStatusRegion } from './ComposerStatusRegion'

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

test('toggles one detail panel at a time and exposes an explicit close control', async () => {
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

  expect(firstTrigger).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(firstTrigger)
  expect(firstTrigger).toHaveAttribute('aria-expanded', 'true')
  expect(firstPanel).not.toHaveAttribute('hidden')
  expect(secondPanel).toHaveAttribute('hidden')

  fireEvent.click(secondTrigger)
  expect(firstTrigger).toHaveAttribute('aria-expanded', 'false')
  expect(secondTrigger).toHaveAttribute('aria-expanded', 'true')
  expect(firstPanel).toHaveAttribute('hidden')
  expect(secondPanel).not.toHaveAttribute('hidden')

  fireEvent.click(screen.getByRole('button', { name: 'composer_status.closeDetails' }))
  expect(secondTrigger).toHaveAttribute('aria-expanded', 'false')
  expect(secondTrigger).toHaveFocus()
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
  fireEvent.click(questionsTrigger)

  const answerDraft = screen.getByRole('textbox', { name: 'Answer draft' })
  fireEvent.change(answerDraft, { target: { value: 'unsent answer' } })
  fireEvent.click(queueTrigger)

  expect(screen.getByTestId('composer-status-content-questions')).toHaveAttribute('hidden')
  expect(answerDraft).toHaveValue('unsent answer')
  expect(document.querySelector('[aria-label="Answer draft"]')).toBe(answerDraft)

  fireEvent.click(questionsTrigger)
  expect(screen.getByTestId('composer-status-content-questions')).not.toHaveAttribute('hidden')
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
  fireEvent.click(trigger)
  const draft = screen.getByRole('textbox', { name: 'Answer draft' })
  draft.focus()
  fireEvent.keyDown(draft, { key: 'Escape' })

  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect(trigger).toHaveFocus()
  expect(screen.getByTestId('composer-status-content-questions')).toHaveAttribute('hidden')
})

test('compact summary keeps item counts and meaningful attention summaries separate', async () => {
  render(
    <ComposerStatusRegion>
      <ComposerStatusItem id="questions" title="Questions" count={3} summary="1 execution failed" attention>
        <p>Question details</p>
      </ComposerStatusItem>
      <ComposerStatusItem id="queue" title="Message queue" count={10} summary="1 message failed" attention>
        <p>Queue details</p>
      </ComposerStatusItem>
      <ComposerStatusItem id="plan" title="Plan" count={5}>
        <p>Plan details</p>
      </ComposerStatusItem>
    </ComposerStatusRegion>
  )

  const region = await screen.findByTestId('composer-status-region')
  fireEvent.click(screen.getByRole('button', { name: 'composer_status.collapseRegion' }))

  const compactButton = screen.getByRole('button', { name: /composer_status\.expandRegion/ })
  expect(compactButton).toHaveTextContent('Questions 3')
  expect(compactButton).toHaveTextContent('Message queue 10')
  expect(compactButton).toHaveTextContent('Plan 5')
  expect(compactButton).toHaveTextContent('composer_status.attentionCount 2')
  expect(region).toHaveTextContent('1 execution failed')
  expect(region).toHaveTextContent('1 message failed')
})

test('keeps short non-attention status text visible in the full row and compact summary', async () => {
  render(
    <ComposerStatusRegion>
      <ComposerStatusItem id="goal" title="Task plan" order={0}>
        <p>Plan details</p>
      </ComposerStatusItem>
      <ComposerStatusItem
        id="queue"
        title="Message queue"
        count={3}
        statusText="1 awaiting delivery"
        summary="Full delivery lifecycle details"
        order={1}
      >
        <p>Queue details</p>
      </ComposerStatusItem>
    </ComposerStatusRegion>
  )

  const queueTrigger = await screen.findByRole('button', { name: /Message queue/ })
  expect(queueTrigger).toHaveTextContent('1 awaiting delivery')
  expect(queueTrigger).not.toHaveTextContent('Full delivery lifecycle details')

  fireEvent.click(screen.getByRole('button', { name: 'composer_status.collapseRegion' }))
  const compactButton = screen.getByRole('button', { name: /composer_status\.expandRegion/ })
  expect(compactButton).toHaveTextContent('1 awaiting delivery')
  expect(compactButton).toHaveTextContent('Message queue 3')
})

test('explicit order puts the goal first in both the DOM and primary summary', async () => {
  render(
    <ComposerStatusRegion>
      <ComposerStatusItem id="questions" title="Questions" count={2}>
        <p>Question details</p>
      </ComposerStatusItem>
      <ComposerStatusItem
        id="goal"
        title="Goal"
        summary="Build the requested composer status experience"
        order={0}
      >
        <p>Goal details</p>
      </ComposerStatusItem>
    </ComposerStatusRegion>
  )

  const group = await screen.findByRole('group', { name: 'composer_status.title' })
  const itemOrder = [...group.querySelectorAll<HTMLElement>('[data-status-item]')]
    .map(element => element.dataset.statusItem)
  expect(itemOrder).toEqual(['goal', 'questions'])
  expect(screen.getByRole('button', { name: /Goal/ })).toHaveTextContent(
    'Build the requested composer status experience'
  )
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
  fireEvent.click(trigger)
  const panel = screen.getByTestId('composer-status-content-questions')
  const draft = screen.getByRole('textbox', { name: 'Saved draft' })
  fireEvent.change(draft, { target: { value: 'answer in progress' } })
  panel.scrollTop = 47

  rerender(<DynamicStatus count={2} summary="Two pending" />)

  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByTestId('composer-status-content-questions')).toBe(panel)
  expect(panel.scrollTop).toBe(47)
  expect(screen.getByRole('textbox', { name: 'Saved draft' })).toBe(draft)
  expect(draft).toHaveValue('answer in progress')
})

test('owner changes reset the selected panel without remounting child drafts', async () => {
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
  fireEvent.click(trigger)
  const draft = screen.getByRole('textbox', { name: 'Owned draft' })
  fireEvent.change(draft, { target: { value: 'keep this draft' } })

  rerender(<OwnedStatus ownerKey="device:task:thread-two" />)

  expect(await screen.findByRole('button', { name: /Questions/ })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByTestId('composer-status-content-questions')).toHaveAttribute('hidden')
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
  expect(notice.parentElement?.compareDocumentPosition(statusRegion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
