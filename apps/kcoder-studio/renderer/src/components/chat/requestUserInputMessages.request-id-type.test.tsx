import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { RequestUserInputPayload } from './RequestUserInputCard'
import { ToolBlocksDisplay } from './blocks/ToolBlocksDisplay'
import {
  applyRequestUserInputResponseToMessages,
  createRequestUserInputAliasTracker,
  isHiddenRequestUserInputBlock,
  observeRequestUserInputAliases,
  requestUserInputBlockKey,
  requestUserInputRelatedKeysForPayloads,
  requestUserInputSettledKeysForPayloads,
} from './requestUserInputMessages'
import type { WorkbenchMessage } from '@/types/workbench'

const payloads: RequestUserInputPayload[] = [1, '1'].map(requestId => ({
  kind: 'request_user_input', requestId, itemId: 'question-1',
  threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
  questions: [{ id: 'choice', question: 'Which source?', options: [{ label: 'Keep' }] }],
}))
const blocks = payloads.map((renderPayload, index) => ({
  id: `block-${index}`, type: 'tool' as const, toolName: 'AskUserQuestion',
  status: 'pending' as const, renderPayload,
}))

for (const requestId of [1, '1']) {
  test(`settling ${JSON.stringify(requestId)} preserves the other JSON request namespace and draft`, () => {
    const tracker = createRequestUserInputAliasTracker()
    observeRequestUserInputAliases(tracker, payloads)
    const submit = vi.fn(() => false)
    const view = render(<ToolBlocksDisplay blocks={blocks} isStreaming onRequestUserInputSubmit={submit} />)
    const otherIndex = typeof requestId === 'number' ? 1 : 0
    const retainedDraft = screen.getAllByTestId('request-user-input-custom-choice')[otherIndex]
    fireEvent.change(retainedDraft, { target: { value: 'Retain the other request draft' } })
    const response = { requestId, itemId: 'question-1', threadId: 'thread', turnId: 'turn',
      appServerEpoch: 'epoch', answers: { choice: { answers: ['Keep'] } } }
    const hidden = new Set(requestUserInputSettledKeysForPayloads(payloads, response, tracker.aliasesByKey))
    expect(isHiddenRequestUserInputBlock(blocks[otherIndex], hidden)).toBe(false)
    expect(isHiddenRequestUserInputBlock(blocks[1 - otherIndex], hidden)).toBe(true)
    view.rerender(<ToolBlocksDisplay blocks={blocks} isStreaming
      hiddenRequestUserInputIds={hidden} onRequestUserInputSubmit={submit} />)
    expect(screen.getByTestId('request-user-input-custom-choice')).toBe(retainedDraft)
    expect(retainedDraft).toHaveValue('Retain the other request draft')
    expect(submit).not.toHaveBeenCalled()

    const messages = [{ id: 'assistant', role: 'assistant', blocks }] as WorkbenchMessage[]
    const updated = applyRequestUserInputResponseToMessages(messages, response)
    expect(updated[0].blocks?.[otherIndex].status).toBe('pending')
    expect(updated[0].blocks?.[1 - otherIndex].status).toBe('done')
  })
}

test('typed transport keys also stay distinct for worker questions and quoted string IDs', () => {
  const sourceAgent = { parentSessionId: 'thread', agentId: 'worker' }
  const keys = [1, '1', '"1"'].map(requestId => requestUserInputBlockKey({
    ...blocks[0], renderPayload: { ...payloads[0], requestId, sourceAgent },
  }))
  expect(new Set(keys).size).toBe(3)
  const related = requestUserInputRelatedKeysForPayloads(payloads, { requestId: 1, answers: {} })
  expect(related).not.toEqual([])
})
