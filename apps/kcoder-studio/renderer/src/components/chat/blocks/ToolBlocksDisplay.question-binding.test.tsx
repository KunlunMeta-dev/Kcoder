import '@/i18n'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { ProcessingBlock } from '@/types/workbench'
import { requestUserInputRelatedKeysForPayloads } from '../requestUserInputMessages'
import { ToolBlocksDisplay } from './ToolBlocksDisplay'

const payloads = [
  { kind: 'request_user_input', requestId: 41, itemId: 'question-first' },
  { kind: 'request_user_input', requestId: 42, itemId: 'question-second' },
].map((payload, index) => ({
  ...payload,
  questions: [{ id: `choice-${index}`, question: `Original question ${index + 1}`, options: [] }],
}))
const blocks: ProcessingBlock[] = payloads.map((renderPayload, index) => ({
  id: `question-block-${index}`,
  subtaskId: `question-${index}`,
  createdAt: 1_800_000_000_000 + index,
  type: 'tool',
  status: 'pending',
  toolName: 'AskUserQuestion',
  renderPayload,
}))

test.each([
  { kind: 'request_user_input', requestId: 41 },
  { kind: 'request_user_input', itemId: 'question-second' },
])('conflicting answered keys preserve both cards and the original draft: %j', legacy => {
  const submit = vi.fn(() => false)
  const { rerender } = render(
    <ToolBlocksDisplay blocks={blocks} isStreaming onRequestUserInputSubmit={submit} />
  )
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice-0'), {
    target: { value: '保留第一张卡片的回答草稿' },
  })
  const hidden = new Set(requestUserInputRelatedKeysForPayloads([...payloads, legacy], {
    requestId: 41, itemId: 'question-second', answers: {},
  }))
  rerender(
    <ToolBlocksDisplay blocks={blocks} isStreaming hiddenRequestUserInputIds={hidden}
      onRequestUserInputSubmit={submit} />
  )

  const cards = screen.getAllByTestId('request-user-input-card')
  expect(cards).toHaveLength(2)
  expect(screen.getByTestId('request-user-input-custom-choice-0'))
    .toHaveValue('保留第一张卡片的回答草稿')
  expect(submit).not.toHaveBeenCalled()
  fireEvent.click(within(cards[0]).getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    requestId: 41,
    itemId: 'question-first',
    answers: { 'choice-0': { answers: ['保留第一张卡片的回答草稿'] } },
  }))
})
