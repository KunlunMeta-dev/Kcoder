import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RequestUserInputCard, RequestUserInputSummary } from './RequestUserInputCard'

const paddedId = ' choice\u00a0'

test('distinct original item IDs keep independent drafts and answer keys', () => {
  const submit = vi.fn()
  render(<RequestUserInputCard
    payload={{ questions: ['choice', paddedId].map(id => ({
      id, question: `Original ${id}`, options: [],
    })) }}
    autoSubmitOnOptionSelect={false} requireAnswer onSubmit={submit}
  />)
  const [first, second] = screen.getAllByRole('textbox')
  fireEvent.change(first, { target: { value: 'First answer' } })
  expect(second).toHaveValue('')
  expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
  fireEvent.change(second, { target: { value: 'Second answer' } })
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    answers: { choice: { answers: ['First answer'] }, [paddedId]: { answers: ['Second answer'] } },
  }))
})

for (const multiSelect of [false, true]) {
  test(`ID-based choices preserve their exact option identities (multiple=${multiSelect})`, () => {
    const submit = vi.fn()
    render(<RequestUserInputCard
      payload={{ questions: [{ id: 'question', question: 'Which?', multiSelect, isOther: false,
        options: [{ id: 'choice', label: 'First' }, { id: paddedId, label: 'Second' }] }] }}
      selectionValue="id" autoSubmitOnOptionSelect={false} preselectFirstOption={false}
      requireAnswer onSubmit={submit}
    />)
    const first = screen.getByTestId('request-user-input-option-question-0')
    const second = screen.getByTestId('request-user-input-option-question-1')
    fireEvent.click(second)
    if (multiSelect) expect(first).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
    expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      answers: { question: { answers: [paddedId] } },
    }), { question: { selectedOptionIds: [paddedId] } })
  })
}

test('summary reads the answer using the exact original item ID', () => {
  render(<RequestUserInputSummary payload={{
    questions: [{ id: paddedId, question: 'Original question' }],
    response: { answers: { [paddedId]: { answers: ['Original answer'] } } },
  }} />)
  expect(screen.getByText('Original answer')).toBeVisible()
})
