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

for (const difference of ['option identity', 'freeform policy'] as const) {
  test(`restoration keeps the original card and draft when siblings differ by ${difference}`, () => {
    const restored: RequestUserInputPayload[] = ['a', 'b'].map(id => ({
      kind: 'request_user_input', itemId: `restored-${id}`,
      questions: [{
        id: 'choice', question: 'Continue?',
        isOther: difference === 'option identity' || id === 'a',
        options: [{ id: difference === 'option identity' ? id : 'yes', label: 'Yes' }],
      }],
    }))
    const live = restored.map((payload, index) => ({
      ...payload, requestId: index + 1, itemId: `live-${index + 1}`,
    }))
    const tracker = createRequestUserInputAliasTracker()
    observeRequestUserInputAliases(tracker, restored)
    // Recovery can return current requests in a different order from history.
    observeRequestUserInputAliases(tracker, [live[1], live[0]])
    const hidden = new Set(requestUserInputRelatedKeysForPayloads(tracker.previousPayloads, {
      requestId: live[1].requestId, itemId: live[1].itemId,
      answers: { choice: { answers: ['Yes'] } },
    }, tracker.aliasesByKey))
    const blocks = restored.map(renderPayload => ({
      id: renderPayload.itemId!, type: 'tool' as const, toolName: 'AskUserQuestion',
      status: 'pending' as const, renderPayload,
    }))
    const submit = vi.fn(() => false)
    const { rerender } = render(
      <ToolBlocksDisplay blocks={blocks} isStreaming onRequestUserInputSubmit={submit} />
    )
    fireEvent.change(screen.getAllByTestId('request-user-input-custom-choice')[0], {
      target: { value: 'Keep the first original answer draft' },
    })
    rerender(<ToolBlocksDisplay blocks={blocks} isStreaming
      hiddenRequestUserInputIds={hidden} onRequestUserInputSubmit={submit} />)
    expect.soft(hidden.has('item:restored-a')).toBe(false)
    expect.soft(hidden.has('item:restored-b')).toBe(true)
    expect(screen.getByTestId('request-user-input-custom-choice'))
      .toHaveValue('Keep the first original answer draft')
    expect(submit).not.toHaveBeenCalled()
  })
}

test('legacy freeform spelling and omitted defaults still identify the same restored question', () => {
  const restored: RequestUserInputPayload = {
    kind: 'request_user_input', itemId: 'restored',
    questions: [{ id: 'choice', question: 'Continue?', options: [{ label: 'Yes' }] }],
  }
  for (const freeform of [{ isOther: true }, { is_other: true }]) {
    const live = { ...restored, itemId: 'live', requestId: 1,
      questions: restored.questions!.map(question => ({ ...question, ...freeform })) }
    const tracker = createRequestUserInputAliasTracker()
    observeRequestUserInputAliases(tracker, [restored])
    observeRequestUserInputAliases(tracker, [live])
    expect(requestUserInputRelatedKeysForPayloads([live], {
      requestId: 1, itemId: 'live', answers: {},
    }, tracker.aliasesByKey)).toContain('item:restored')
  }
})
