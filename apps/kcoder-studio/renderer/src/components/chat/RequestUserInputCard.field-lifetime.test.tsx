import '@/i18n'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { RequestUserInputCard } from './RequestUserInputCard'

const controls = vi.hoisted(() => new Map<string, Record<string, (event?: unknown) => void>>())

// Retain the actual DOM callbacks to reproduce delivery from an older render.
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const original = await importOriginal<typeof import('react/jsx-dev-runtime')>()
  return { ...original, jsxDEV: (...args: Parameters<typeof original.jsxDEV>) => {
    const props = args[1] as Record<string, unknown>
    const id = props?.['data-testid']
    if (typeof id === 'string' && (id.startsWith('request-user-input-custom-') ||
        id.startsWith('request-user-input-option-')))
      controls.set(id, props as Record<string, (event?: unknown) => void>)
    return original.jsxDEV(...args)
  } }
})

const payload = {
  threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch', requestId: 7, itemId: 'question',
  questions: [{ id: 'choice', question: 'Which approach?', options: [
    { id: 'first', label: 'First approach' }, { id: 'second', label: 'Second approach' },
  ] }],
}

beforeEach(() => controls.clear())

for (const transition of ['disable', 'recover-connection'] as const) {
  for (const event of ['text', 'option'] as const) {
    test(`a queued ${event} edit cannot overwrite the retained answer after ${transition}`, async () => {
      const submit = vi.fn()
      const props = { payload, selectionValue: 'id' as const, autoSubmitOnOptionSelect: false,
        preselectFirstOption: false, requireAnswer: true, onSubmit: submit }
      const view = render(<RequestUserInputCard {...props} />)
      const draft = screen.getByTestId('request-user-input-custom-choice')
      fireEvent.change(draft, { target: { value: 'Original unsent answer' } })
      const previous = controls.get(event === 'text'
        ? 'request-user-input-custom-choice' : 'request-user-input-option-choice-1')!
      expect(previous).toBeDefined()
      const retained = event === 'text' ? previous.onChange : previous.onClick
      view.rerender(<RequestUserInputCard {...props} disabled={transition === 'disable'}
        submissionEpoch={transition === 'recover-connection' ? 1 : 0} />)
      await act(async () => retained({ target: { value: 'Obsolete queued edit' } }))
      expect(draft).toHaveValue('Original unsent answer')
      expect(submit).not.toHaveBeenCalled()
      view.rerender(<RequestUserInputCard {...props} submissionEpoch={1} />)
      fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
      expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        answers: { choice: { answers: ['Original unsent answer'] } },
      }), { choice: { selectedOptionIds: [], text: 'Original unsent answer' } })
    })
  }
}

test('a change delivered while input is disabled preserves the draft and allows later editing', () => {
  const view = render(<RequestUserInputCard payload={payload} />)
  const draft = screen.getByTestId('request-user-input-custom-choice')
  fireEvent.change(draft, { target: { value: 'Original unsent answer' } })
  view.rerender(<RequestUserInputCard payload={payload} disabled />)
  fireEvent.change(draft, { target: { value: 'Late disabled edit' } })
  expect(draft).toHaveValue('Original unsent answer')
  view.rerender(<RequestUserInputCard payload={payload} />)
  fireEvent.change(draft, { target: { value: 'Current intentional edit' } })
  expect(draft).toHaveValue('Current intentional edit')
})
