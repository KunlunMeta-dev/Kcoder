import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ToolBlocksDisplay } from './blocks/ToolBlocksDisplay'
import {
  createRequestUserInputAliasTracker,
  observeRequestUserInputAliases,
  requestUserInputRelatedKeysForPayloads,
} from './requestUserInputMessages'

test('answering a partial recovery preserves both unconfirmed historical cards and their drafts', () => {
  const questions = [{ id: 'choice', question: 'Continue?', options: [] }]
  const restored = ['a', 'b'].map(id => ({
    kind: 'request_user_input', itemId: `restored-${id}`, questions,
  }))
  const live = { ...restored[1], requestId: 2, itemId: 'rebased-b' }
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, restored)
  observeRequestUserInputAliases(tracker, [live])
  const blocks = restored.map(renderPayload => ({
    id: renderPayload.itemId, type: 'tool' as const, toolName: 'AskUserQuestion',
    status: 'pending' as const, renderPayload,
  }))
  const submit = vi.fn(() => false)
  const { rerender } = render(
    <ToolBlocksDisplay blocks={blocks} isStreaming onRequestUserInputSubmit={submit} />
  )
  screen.getAllByTestId('request-user-input-custom-choice').forEach((input, index) => {
    fireEvent.change(input, { target: { value: `Original draft ${index}` } })
  })
  const hidden = new Set(requestUserInputRelatedKeysForPayloads([live], {
    requestId: live.requestId, itemId: live.itemId, answers: { choice: { answers: ['Yes'] } },
  }, tracker.aliasesByKey))
  rerender(<ToolBlocksDisplay blocks={blocks} isStreaming
    hiddenRequestUserInputIds={hidden} onRequestUserInputSubmit={submit} />)
  expect(screen.getAllByTestId('request-user-input-card')).toHaveLength(2)
  screen.getAllByTestId('request-user-input-custom-choice').forEach((input, index) => {
    expect(input).toHaveValue(`Original draft ${index}`)
  })
  expect(submit).not.toHaveBeenCalled()
})
