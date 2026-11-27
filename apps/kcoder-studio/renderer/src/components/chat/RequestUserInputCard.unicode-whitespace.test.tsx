import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RequestUserInputCard } from './RequestUserInputCard'

test.each([false, true])('async answer form matches State Unicode whitespace (multiSelect=%s)', multiSelect => {
  const submit = vi.fn()
  render(<RequestUserInputCard payload={{ questions: [{ id: 'item', question: 'Continue?', multiSelect,
    options: [{ id: 'yes', label: 'Yes' }] }] }} selectionValue="id" requireAnswer
    autoSubmitOnOptionSelect={false} preselectFirstOption={false} onSubmit={submit} />)
  const input = screen.getByTestId('request-user-input-custom-item')
  const send = screen.getByTestId('request-user-input-submit-button')
  fireEvent.change(input, { target: { value: '\u0085' } })
  expect(send).toBeDisabled()
  fireEvent.submit(screen.getByTestId('request-user-input-card'))
  expect(submit).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: ' \uFEFF ' } })
  expect(send).toBeEnabled()
  fireEvent.click(send)
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    answers: { item: { answers: [' \uFEFF '] } },
  }), { item: { selectedOptionIds: [], text: ' \uFEFF ' } })
})

test('blank Unicode input keeps an async single-choice selection', () => {
  const submit = vi.fn()
  render(<RequestUserInputCard payload={{ questions: [{ id: 'item', question: 'Continue?',
    options: [{ id: 'yes', label: 'Yes' }] }] }} selectionValue="id" requireAnswer
    autoSubmitOnOptionSelect={false} preselectFirstOption={false} onSubmit={submit} />)
  fireEvent.click(screen.getByTestId('request-user-input-option-item-0'))
  fireEvent.change(screen.getByTestId('request-user-input-custom-item'), { target: { value: '\u0085' } })
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.anything(), { item: { selectedOptionIds: ['yes'] } })
})

test('Unicode content in original item IDs is never replaced by a fallback answer key', () => {
  const submit = vi.fn()
  render(<RequestUserInputCard payload={{ questions: [{ id: '\uFEFF', question: 'Original question', options: [] }] }}
    selectionValue="id" requireAnswer autoSubmitOnOptionSelect={false} onSubmit={submit} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Original answer' } })
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    answers: { ['\uFEFF']: { answers: ['Original answer'] } },
  }), { ['\uFEFF']: { selectedOptionIds: [], text: 'Original answer' } })
})

test('State-valid Unicode option labels remain selectable on a closed-choice question', () => {
  const submit = vi.fn()
  render(<RequestUserInputCard payload={{ questions: [{ id: 'item', question: 'Original question', isOther: false,
    options: [{ id: 'choice', label: '\uFEFF' }] }] }} selectionValue="id" requireAnswer
    preselectFirstOption={false} autoSubmitOnOptionSelect={false} onSubmit={submit} />)
  fireEvent.click(screen.getByTestId('request-user-input-option-item-0'))
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.anything(), { item: { selectedOptionIds: ['choice'] } })
})

test('an opaque Unicode option ID satisfies the required single-choice answer', () => {
  const submit = vi.fn()
  render(<RequestUserInputCard payload={{ questions: [{ id: 'item', question: 'Original question', isOther: false,
    options: [{ id: '\uFEFF', label: 'Original choice' }] }] }} selectionValue="id" requireAnswer
    preselectFirstOption={false} autoSubmitOnOptionSelect={false} onSubmit={submit} />)
  fireEvent.click(screen.getByTestId('request-user-input-option-item-0'))
  expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled()
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.anything(), { item: { selectedOptionIds: ['\uFEFF'] } })
})
