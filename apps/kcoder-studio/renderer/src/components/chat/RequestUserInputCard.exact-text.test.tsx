import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RequestUserInputCard } from './RequestUserInputCard'

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
