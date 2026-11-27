import '@/i18n'
import { useLayoutEffect, type ButtonHTMLAttributes } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { RequestUserInputCard } from './RequestUserInputCard'
import { createRequestUserInputAliasTracker, observeRequestUserInputAliases } from './requestUserInputMessages'

const queued = vi.hoisted(() => ({ submit: undefined as undefined | (() => void) }))
vi.mock('@/components/ui/button', () => ({
  Button: ({ onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => {
    queued.submit = () => onClick?.({} as never)
    return <button {...props} onClick={onClick} />
  },
}))

const original = {
  requestId: 7, itemId: 'question', threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
  questions: [{ id: 'choice', question: 'Continue?', options: [] }],
}

beforeEach(() => { queued.submit = undefined })

test.each(['unmount', 'replace-owner', 'disable', 'recover-connection'] as const)(
  'a queued answer cannot outlive the %s commit', async transition => {
    const submit = vi.fn(() => false)
    function Host({ changed }: { changed: boolean }) {
      useLayoutEffect(() => {
        // Drain the previous event after commit, before passive effect cleanup.
        if (changed) retained?.()
      }, [changed])
      return <>
        {!(changed && transition === 'unmount') && <RequestUserInputCard
          payload={changed && transition === 'replace-owner' ? { ...original, requestId: 8 } : original}
          disabled={changed && transition === 'disable'}
          submissionEpoch={changed && transition === 'recover-connection' ? 1 : 0}
          onSubmit={submit}
        />}
        <input data-testid="composer" />
      </>
    }
    const view = render(<Host changed={false} />)
    fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
      target: { value: 'Original answer only' },
    })
    const retained = queued.submit
    expect(retained).toBeTypeOf('function')
    await act(async () => { view.rerender(<Host changed />) })
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer')).toBeEnabled()

    await act(async () => { view.rerender(<Host changed={false} />) })
    const input = screen.getByTestId('request-user-input-custom-choice')
    if (transition === 'disable' || transition === 'recover-connection')
      expect(input).toHaveValue('Original answer only')
    await act(async () => { retained?.() })
    expect(submit).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'Current answer' } })
    fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
    expect(submit).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 7, answers: { choice: { answers: ['Current answer'] } },
    }))
  },
)

test('a queued answer cannot submit the previous draft after a newer edit commits', async () => {
  const submit = vi.fn(() => false)
  render(<RequestUserInputCard payload={original} selectionValue="id"
    requireAnswer onSubmit={submit} />)
  const input = screen.getByTestId('request-user-input-custom-choice')
  fireEvent.change(input, { target: { value: 'Previous answer' } })
  const retained = queued.submit
  expect(retained).toBeTypeOf('function')

  fireEvent.change(input, { target: { value: 'Corrected answer' } })
  await act(async () => { retained?.() })
  expect(submit).not.toHaveBeenCalled()
  expect(input).toHaveValue('Corrected answer')

  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    choice: { selectedOptionIds: [], text: 'Corrected answer' },
  })
})

test('a queued answer cannot use the submission callback replaced by a new commit', async () => {
  const previousSubmit = vi.fn(() => false)
  const currentSubmit = vi.fn(() => false)
  const view = render(<RequestUserInputCard payload={original} selectionValue="id"
    requireAnswer onSubmit={previousSubmit} />)
  const input = screen.getByTestId('request-user-input-custom-choice')
  fireEvent.change(input, { target: { value: 'Keep this draft' } })
  const retained = queued.submit!
  expect(retained).toBeTypeOf('function')

  view.rerender(<RequestUserInputCard payload={original} selectionValue="id"
    requireAnswer onSubmit={currentSubmit} />)
  await act(async () => { retained() })
  expect(previousSubmit).not.toHaveBeenCalled()
  expect(currentSubmit).not.toHaveBeenCalled()
  expect(input).toHaveValue('Keep this draft')

  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(currentSubmit).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    choice: { selectedOptionIds: [], text: 'Keep this draft' },
  })
})

test('a queued answer cannot use the sparse locator after a live alias restores the request', async () => {
  const restored = { ...original, requestId: undefined, threadId: undefined, itemId: 'restored-question' }
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, [restored, original])
  const submit = vi.fn(() => false)
  const props = { aliasesByKey: tracker.aliasesByKey, onSubmit: submit }
  const view = render(<RequestUserInputCard {...props} payload={restored} />)
  const draft = screen.getByTestId('request-user-input-custom-choice')
  fireEvent.change(draft, { target: { value: 'Keep the recovered draft' } })
  const retained = queued.submit!

  view.rerender(<RequestUserInputCard {...props} payload={original} />)
  expect(screen.getByTestId('request-user-input-custom-choice')).toBe(draft)
  expect(draft).toHaveValue('Keep the recovered draft')
  await act(async () => { retained() })
  expect(submit).not.toHaveBeenCalled()

  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    requestId: 7, itemId: 'question', threadId: 'thread',
    answers: { choice: { answers: ['Keep the recovered draft'] } },
  }))
})
