import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RequestUserInputCard } from './RequestUserInputCard'

test.each(['\uFEFF', '\uFEFF原始说明\uFEFF', '  原始说明\n'])('preserves question metadata %j and the original answer identity', metadata => {
  const submit = vi.fn()
  render(<RequestUserInputCard
    payload={{ requestId: 92, threadId: 'thread', turnId: 'turn', questions: [{
      id: 'original-item', header: metadata, question: 'Choose the original option',
      options: [{ id: 'original-option', label: 'Keep', description: metadata }],
    }] }}
    selectionValue="id" autoSubmitOnOptionSelect={false} preselectFirstOption={false}
    requireAnswer onSubmit={submit}
  />)
  expect(screen.getAllByText(metadata, { exact: true, normalizer: value => value })).toHaveLength(2)
  fireEvent.click(screen.getByTestId('request-user-input-option-original-item-0'))
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    threadId: 'thread', turnId: 'turn', answers: { 'original-item': { answers: ['original-option'] } },
  }), { 'original-item': { selectedOptionIds: ['original-option'] } })
})
