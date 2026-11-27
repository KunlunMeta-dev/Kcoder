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

test('reordered recovery distinguishes identical labels with different submitted option values', () => {
  const restored: RequestUserInputPayload[] = ['source-a', 'source-b'].map(value => ({
    kind: 'request_user_input', itemId: `restored-${value}`,
    threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
    questions: [{ id: 'choice', question: 'Which source?', options: [{ label: 'Use source', value }] }],
  }))
  const live = restored.map((payload, index) => ({
    ...payload, requestId: index + 1, itemId: `live-${index + 1}`,
  }))
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, restored)
  observeRequestUserInputAliases(tracker, [live[1], live[0]])

  const blocks = restored.map(renderPayload => ({
    id: renderPayload.itemId!, type: 'tool' as const, toolName: 'AskUserQuestion',
    status: 'pending' as const, renderPayload,
  }))
  const submit = vi.fn(() => false)
  const view = render(<ToolBlocksDisplay blocks={blocks} isStreaming onRequestUserInputSubmit={submit} />)
  const originalDraft = screen.getAllByTestId('request-user-input-custom-choice')[0]
  fireEvent.change(originalDraft, { target: { value: 'Keep the first source draft' } })
  const hidden = new Set(requestUserInputRelatedKeysForPayloads(tracker.previousPayloads, {
    ...live[1], answers: { choice: { answers: ['source-b'] } },
  }, tracker.aliasesByKey))
  view.rerender(<ToolBlocksDisplay blocks={blocks} isStreaming
    hiddenRequestUserInputIds={hidden} onRequestUserInputSubmit={submit} />)

  expect.soft(hidden.has('item:restored-source-a')).toBe(false)
  expect.soft(hidden.has('item:restored-source-b')).toBe(true)
  expect.soft(screen.getByTestId('request-user-input-custom-choice')).toBe(originalDraft)
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('Keep the first source draft')
  expect(submit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('request-user-input-option-choice-0'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    itemId: 'restored-source-a', answers: { choice: { answers: ['source-a'] } },
  }))
})

test('an explicit label value and its omitted legacy default restore the same original option', () => {
  const restored: RequestUserInputPayload = {
    kind: 'request_user_input', itemId: 'restored',
    questions: [{ id: 'choice', question: 'Which source?', options: [{ label: 'Use source' }] }],
  }
  const live = { ...restored, requestId: 1, itemId: 'live',
    questions: [{ ...restored.questions![0], options: [{ label: 'Use source', value: 'Use source' }] }] }
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, [restored])
  observeRequestUserInputAliases(tracker, [live])
  expect(requestUserInputRelatedKeysForPayloads([live], {
    ...live, answers: { choice: { answers: ['Use source'] } },
  }, tracker.aliasesByKey)).toContain('item:restored')
})
