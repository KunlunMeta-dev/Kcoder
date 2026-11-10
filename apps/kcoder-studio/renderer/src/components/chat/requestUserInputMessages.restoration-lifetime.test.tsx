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

const restored: RequestUserInputPayload = {
  kind: 'request_user_input', itemId: 'historical',
  threadId: 'original-task', turnId: 'original-turn', appServerEpoch: 'original-server',
  questions: [{ id: 'choice', question: 'Continue?', options: [] }],
}

for (const field of ['threadId', 'turnId', 'appServerEpoch'] as const) {
  test(`restoration cannot hide another ${field}'s identical question or discard its draft`, () => {
    const live = { ...restored, requestId: 7, itemId: 'live', [field]: 'other' }
    const tracker = createRequestUserInputAliasTracker()
    observeRequestUserInputAliases(tracker, [restored])
    observeRequestUserInputAliases(tracker, [live])
    const hidden = new Set(requestUserInputRelatedKeysForPayloads([live], {
      requestId: live.requestId, itemId: live.itemId, answers: {},
    }, tracker.aliasesByKey))
    const blocks = [{ id: 'historical', type: 'tool' as const, toolName: 'AskUserQuestion',
      status: 'pending' as const, renderPayload: restored }]
    const submit = vi.fn()
    const { rerender } = render(<ToolBlocksDisplay blocks={blocks} isStreaming
      onRequestUserInputSubmit={submit} />)
    fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
      target: { value: 'Keep the original answer draft' },
    })
    rerender(<ToolBlocksDisplay blocks={blocks} isStreaming hiddenRequestUserInputIds={hidden}
      onRequestUserInputSubmit={submit} />)
    expect.soft(tracker.aliasesByKey.size).toBe(0)
    expect(screen.getByTestId('request-user-input-custom-choice'))
      .toHaveValue('Keep the original answer draft')
    expect(submit).not.toHaveBeenCalled()
  })

  test.each(['same', 'omitted'])(`restoration preserves %s legacy ${field} bindings`, mode => {
    const historical = { ...restored }
    if (mode === 'omitted') delete historical[field]
    const live = { ...restored, requestId: 7, itemId: 'live' }
    const tracker = createRequestUserInputAliasTracker()
    observeRequestUserInputAliases(tracker, [historical])
    observeRequestUserInputAliases(tracker, [live])
    expect(requestUserInputRelatedKeysForPayloads([live], {
      requestId: live.requestId, itemId: live.itemId, answers: {},
    }, tracker.aliasesByKey)).toContain('item:historical')
  })
}
