import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { ToolBlocksDisplay } from './blocks/ToolBlocksDisplay'
import {
  applyRequestUserInputResponseToMessages,
  insertUserMessageBeforeRequestUserInput,
  isHiddenRequestUserInputBlock,
  requestUserInputRelatedKeysForPayloads,
} from './requestUserInputMessages'

const cases = [
  {
    name: 'reused request ID',
    bindings: [
      { requestId: 41, itemId: 'old-question' },
      { requestId: 41, itemId: 'new-question' },
    ],
    response: { requestId: 41, answers: {} },
  },
  {
    name: 'reused item ID',
    bindings: [
      { requestId: 41, itemId: 'question' },
      { requestId: 42, itemId: 'question' },
    ],
    response: { itemId: 'question', answers: {} },
  },
]

for (const { name, bindings, response } of cases) {
  const payloads = bindings.map((binding, index) => ({
    kind: 'request_user_input',
    ...binding,
    questions: [{ id: `choice-${index}`, question: `Question ${index}`, options: [] }],
  }))
  const messages = payloads.map((renderPayload, index) => ({
    id: `assistant-${index}`,
    role: 'assistant',
    content: '',
    status: 'done',
    createdAt: '2026-11-04',
    blocks: [
      {
        id: `block-${index}`,
        subtaskId: `question-${index}`,
        type: 'tool',
        toolName: 'AskUserQuestion',
        status: 'pending',
        renderPayload,
      },
    ],
  })) as WorkbenchMessage[]

  test(`${name}: a partial response cannot choose between distinct original bindings`, () => {
    const answer = {
      id: 'reply',
      role: 'user',
      content: 'Answer',
      status: 'done',
      createdAt: '2026-11-04',
    } as WorkbenchMessage
    expect.soft(requestUserInputRelatedKeysForPayloads(payloads, response)).toEqual([])
    expect.soft(applyRequestUserInputResponseToMessages(messages, response)).toBe(messages)
    expect
      .soft(insertUserMessageBeforeRequestUserInput(messages, answer, response))
      .toEqual([...messages, answer])
  })

  test(`${name}: ambiguous answered keys preserve both cards and their drafts`, () => {
    const blocks = messages.flatMap(message => message.blocks ?? [])
    const submit = vi.fn(() => false)
    const { rerender } = render(
      <ToolBlocksDisplay blocks={blocks} isStreaming onRequestUserInputSubmit={submit} />
    )
    fireEvent.change(screen.getByTestId('request-user-input-custom-choice-0'), {
      target: { value: '保留原问题草稿' },
    })
    const hidden = new Set(requestUserInputRelatedKeysForPayloads(payloads, response))
    rerender(
      <ToolBlocksDisplay
        blocks={blocks}
        isStreaming
        hiddenRequestUserInputIds={hidden}
        onRequestUserInputSubmit={submit}
      />
    )
    expect(screen.getAllByTestId('request-user-input-card')).toHaveLength(2)
    expect(screen.getByTestId('request-user-input-custom-choice-0')).toHaveValue('保留原问题草稿')
    expect(submit).not.toHaveBeenCalled()
  })

  test(`${name}: the complete response still settles only its original question`, () => {
    const complete = { ...bindings[1], answers: {} }
    expect(
      applyRequestUserInputResponseToMessages(messages, complete).map(
        message => message.blocks![0].status
      )
    ).toEqual(['pending', 'done'])
    const hidden = new Set(requestUserInputRelatedKeysForPayloads(payloads, complete))
    expect(
      messages.map(message => isHiddenRequestUserInputBlock(message.blocks![0], hidden))
    ).toEqual([false, true])
    render(
      <ToolBlocksDisplay
        blocks={messages.flatMap(message => message.blocks ?? [])}
        isStreaming
        hiddenRequestUserInputIds={hidden}
      />
    )
    expect(screen.getAllByTestId('request-user-input-card')).toHaveLength(1)
    expect(screen.getByTestId('request-user-input-custom-choice-0')).toBeInTheDocument()
  })
}

test('duplicate projections and registered restoration aliases remain compatible with partial replies', () => {
  const original = { kind: 'request_user_input', requestId: 41, itemId: 'original' }
  const restored = { ...original, itemId: 'restored' }
  const response = { requestId: 41, answers: {} }
  expect(requestUserInputRelatedKeysForPayloads([original, { ...original }], response)).toEqual([
    'request:41',
    'item:original',
  ])
  const aliases = new Map([
    ['request:41', new Set(['item:original', 'item:restored'])],
    ['item:original', new Set(['request:41', 'item:restored'])],
    ['item:restored', new Set(['request:41', 'item:original'])],
  ])
  expect(requestUserInputRelatedKeysForPayloads([original, restored], response, aliases)).toEqual([
    'request:41',
    'item:original',
    'item:restored',
  ])
})
