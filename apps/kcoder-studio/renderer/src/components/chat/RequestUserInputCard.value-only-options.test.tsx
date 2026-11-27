import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { RequestUserInputPayload } from './RequestUserInputCard'
import { ToolBlocksDisplay } from './blocks/ToolBlocksDisplay'
import {
  createRequestUserInputAliasTracker,
  observeRequestUserInputAliases,
  requestUserInputRelatedKeysForPayloads,
} from './requestUserInputMessages'

const value = ' 保留原文件 \n'
const restored: RequestUserInputPayload = {
  kind: 'request_user_input', itemId: 'restored-question',
  threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
  questions: [{ id: 'choice', question: 'Which file?', isOther: false,
    options: [{ value }, { label: 'Other file', value: 'other' }] }],
}

test.each([false, true])('a restored value-only choice remains answerable (multiple=%s)', multiSelect => {
  const submit = vi.fn()
  render(<ToolBlocksDisplay isStreaming blocks={[{
    id: 'restored-block', type: 'tool', toolName: 'AskUserQuestion', status: 'pending',
    renderPayload: { ...restored, questions: [{ ...restored.questions![0], multiSelect }] },
  }]} onRequestUserInputSubmit={submit} />)
  const option = screen.getByTestId('request-user-input-option-choice-0')
  expect(option).toHaveTextContent('保留原文件')
  fireEvent.click(option)
  if (multiSelect) {
    fireEvent.click(screen.getByTestId('request-user-input-option-choice-1'))
    fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  }
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch', itemId: 'restored-question',
    answers: { choice: { answers: multiSelect ? [value, 'other'] : [value] } },
  }))
})

test('a value-only restored option pairs with its live display default without crossing another choice', () => {
  const peer = { ...restored, itemId: 'peer-question', questions: [{ ...restored.questions![0],
    options: [{ value: 'peer' }, restored.questions![0].options![1]] }] }
  const live = { ...restored, requestId: 41, itemId: 'live-question',
    questions: [{ ...restored.questions![0], options: [{ label: value, value },
      restored.questions![0].options![1]] }] }
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, [restored, peer])
  observeRequestUserInputAliases(tracker, [live])
  const related = requestUserInputRelatedKeysForPayloads(tracker.previousPayloads,
    { ...live, answers: { choice: { answers: [value] } } }, tracker.aliasesByKey)
  expect(related).toContain('item:restored-question')
  expect(related).not.toContain('item:peer-question')
})
