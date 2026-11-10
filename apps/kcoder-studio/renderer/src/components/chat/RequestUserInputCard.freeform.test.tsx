import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RequestUserInputCard } from './RequestUserInputCard'

const question = {
  id: 'approach', question: 'Which approach should be used?', isOther: true,
  options: [{ label: 'Plan A', description: 'First proposal' }, { label: 'Plan B', description: 'Second proposal' }],
}

test('an unlisted multiline answer starts empty and replaces every suggested single choice', () => {
  const submit = vi.fn()
  render(<RequestUserInputCard payload={{ requestId: 81, questions: [question] }} onSubmit={submit} />)
  const custom = screen.getByTestId('request-user-input-custom-approach')
  expect(custom).toHaveValue('')
  const answer = '两个方案都不采用，先整理原始资料。\n预算为 20 万，时间另行确认。'
  fireEvent.change(custom, { target: { value: answer } })
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    answers: { approach: { answers: [answer] } },
  }))
})

test('choosing a fixed answer after editing free text submits that fixed answer', () => {
  const submit = vi.fn()
  render(<RequestUserInputCard payload={{ requestId: 82, questions: [question] }} onSubmit={submit} />)
  fireEvent.change(screen.getByTestId('request-user-input-custom-approach'), { target: { value: '另一种做法' } })
  fireEvent.click(screen.getByTestId('request-user-input-option-approach-1'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    answers: { approach: { answers: ['Plan B'] } },
  }))
})

test('multiple choice accepts only an unlisted answer with no hidden fixed selection', () => {
  const submit = vi.fn()
  render(<RequestUserInputCard payload={{ requestId: 83, questions: [{ ...question, multiSelect: true }] }} onSubmit={submit} />)
  fireEvent.change(screen.getByTestId('request-user-input-custom-approach'), { target: { value: '都不符合，改用第三种方案。' } })
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    answers: { approach: { answers: ['都不符合，改用第三种方案。'] } },
  }))
})

test('a fixed permission choice does not gain a custom authorization field', () => {
  render(<RequestUserInputCard payload={{ itemId: 'approval-84', questions: [{ ...question, isOther: false }] }} />)
  expect(screen.queryByTestId('request-user-input-custom-approach')).toBeNull()
})

test('ordinary legacy questions also expose free text when the host omits the optional flag', () => {
  const legacy: Omit<typeof question, "isOther"> & { isOther?: boolean } = { ...question }
  delete legacy.isOther
  render(<RequestUserInputCard payload={{ requestId: 85, questions: [legacy] }} />)
  expect(screen.getByTestId('request-user-input-custom-approach')).toHaveValue('')
})

test('permission requests stay fixed even if an older payload incorrectly enables other answers', () => {
  render(<RequestUserInputCard payload={{ itemId: 'approval-86', questions: [question] }} />)
  expect(screen.queryByTestId('request-user-input-custom-approach')).toBeNull()
})

test.each([
  { source: 'question text', prompt: '执行此计划前还需要哪些资料？', option: '生成草稿' },
  { source: 'option label', prompt: '还需要哪些资料？', option: '执行此计划并生成草稿' },
])('$source cannot clear another async answer draft', ({ prompt, option }) => {
  const submit = vi.fn()
  render(<RequestUserInputCard
    payload={{ questions: [
      { id: 'notes', question: prompt, options: [] },
      { id: 'delivery', question: '如何交付？', options: [
        { id: 'draft', label: option },
        { id: 'review', label: '先审核' },
      ] },
    ] }}
    selectionValue="id"
    autoSubmitOnOptionSelect={false}
    preselectFirstOption={false}
    allowImplementationPlanShortcut={false}
    requireAnswer
    onSubmit={submit}
  />)
  const notes = screen.getByTestId('request-user-input-custom-notes')
  fireEvent.change(notes, { target: { value: '预算需财务确认，保留原任务。' } })
  fireEvent.click(screen.getByTestId('request-user-input-option-delivery-1'))
  expect(notes).toHaveValue('预算需财务确认，保留原任务。')
  expect(submit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    answers: {
      notes: { answers: ['预算需财务确认，保留原任务。'] },
      delivery: { answers: ['review'] },
    },
  }), {
    notes: { selectedOptionIds: [], text: '预算需财务确认，保留原任务。' },
    delivery: { selectedOptionIds: ['review'] },
  })
})
