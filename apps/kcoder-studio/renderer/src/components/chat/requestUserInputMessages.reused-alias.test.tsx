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

const questions = [{ id: 'choice', question: 'Continue?', options: [] }]
const restored: RequestUserInputPayload = {
  kind: 'request_user_input', itemId: 'restored', questions,
}
const original = { ...restored, requestId: 41, itemId: 'original' }

for (const reused of ['request', 'item'] as const) {
  const sibling = reused === 'request'
    ? { ...original, itemId: 'sibling' }
    : { ...original, requestId: 42 }
  const payloads = [original, sibling]
  const tracker = () => {
    const value = createRequestUserInputAliasTracker()
    observeRequestUserInputAliases(value, [restored])
    observeRequestUserInputAliases(value, [original])
    observeRequestUserInputAliases(value, payloads)
    return value
  }

  test(`a restoration alias cannot choose a partial reply after ${reused} ID reuse`, () => {
    const aliases = tracker().aliasesByKey
    const response = reused === 'request'
      ? { requestId: 41, answers: {} }
      : { itemId: 'original', answers: {} }
    const blocks = payloads.map((renderPayload, index) => ({
      id: `block-${index}`, type: 'tool' as const, toolName: 'AskUserQuestion',
      status: 'pending' as const, renderPayload,
    }))
    const submit = vi.fn(() => false)
    const { rerender } = render(
      <ToolBlocksDisplay blocks={blocks} isStreaming onRequestUserInputSubmit={submit} />
    )
    fireEvent.change(screen.getAllByTestId('request-user-input-custom-choice')[0], {
      target: { value: 'Keep the original answer draft' },
    })
    const hidden = new Set(requestUserInputRelatedKeysForPayloads(payloads, response, aliases))
    rerender(<ToolBlocksDisplay blocks={blocks} isStreaming
      hiddenRequestUserInputIds={hidden} onRequestUserInputSubmit={submit} />)
    expect.soft([...hidden]).toEqual([])
    expect.soft(screen.getAllByTestId('request-user-input-card')).toHaveLength(2)
    expect(screen.getAllByTestId('request-user-input-custom-choice')[0])
      .toHaveValue('Keep the original answer draft')
    expect(submit).not.toHaveBeenCalled()
  })

  test(`complete replies stay bound after a restored ${reused} ID is reused`, () => {
    const aliases = tracker().aliasesByKey
    const originalKeys = requestUserInputRelatedKeysForPayloads(payloads, {
      requestId: original.requestId, itemId: original.itemId, answers: {},
    }, aliases)
    expect(originalKeys).toContain('item:restored')
    const siblingKeys = requestUserInputRelatedKeysForPayloads(payloads, {
      requestId: sibling.requestId, itemId: sibling.itemId, answers: {},
    }, aliases)
    expect(siblingKeys).toEqual([`request:${sibling.requestId}`, `item:${sibling.itemId}`])
  })
}
