import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RequestUserInputCard, RequestUserInputSummary } from './RequestUserInputCard'

test.each([false, true])('async free text preserves indentation and trailing newlines (multiSelect=%s)', multiSelect => {
  const submit = vi.fn()
  const text = '  print("保留缩进")  \n\n'
  render(<RequestUserInputCard
    payload={{ questions: [{ id: 'code', question: 'Which code?', multiSelect,
      options: [{ id: 'keep', label: 'Keep existing code' }] }] }}
    selectionValue="id" autoSubmitOnOptionSelect={false} preselectFirstOption={false}
    allowImplementationPlanShortcut={false} requireAnswer onSubmit={submit}
  />)
  if (multiSelect) fireEvent.click(screen.getByTestId('request-user-input-option-code-0'))
  fireEvent.change(screen.getByTestId('request-user-input-custom-code'), { target: { value: text } })
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    answers: { code: { answers: multiSelect ? ['keep', text] : [text] } },
  }), { code: { selectedOptionIds: multiSelect ? ['keep'] : [], text } })
})

test('whitespace alone does not satisfy a required async answer', () => {
  const submit = vi.fn()
  render(<RequestUserInputCard payload={{ questions: [{ id: 'code', question: 'Which code?', options: [] }] }}
    selectionValue="id" preselectFirstOption={false} requireAnswer onSubmit={submit} />)
  fireEvent.change(screen.getByTestId('request-user-input-custom-code'), { target: { value: ' \n\t ' } })
  expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
  fireEvent.submit(screen.getByTestId('request-user-input-card'))
  expect(submit).not.toHaveBeenCalled()
})

test('the answered card displays the exact submitted code, including indentation and final newlines', () => {
  const submit = vi.fn()
  const text = '    print("保留缩进")  \n\n'
  const payload = { requestId: 7, itemId: 'question', threadId: 'thread', turnId: 'turn',
    questions: [{ id: 'code', question: 'Which code?', options: [] }] }
  const view = render(<RequestUserInputCard payload={payload} requireAnswer onSubmit={submit} />)
  fireEvent.change(screen.getByTestId('request-user-input-custom-code'), { target: { value: text } })
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledOnce()
  const response = submit.mock.calls[0][0]
  expect(response.answers.code.answers).toEqual([text])
  view.rerender(<RequestUserInputSummary payload={{ ...payload, response }} />)
  const summary = screen.getByTestId('request-user-input-summary')
  expect(summary.querySelector('.whitespace-pre-wrap')?.textContent).toBe(text)
})

test('answer summaries omit blank entries using the same whitespace rules as answer submission', () => {
  const text = '\uFEFF'
  render(<RequestUserInputSummary payload={{
    questions: [{ id: 'answer', question: 'Original response?' }],
    response: { answers: { answer: { answers: [' \n\t', '\u0085', text] } } },
  }} />)
  expect(screen.getByTestId('request-user-input-summary')
    .querySelector('.whitespace-pre-wrap')?.textContent).toBe(text)
})
