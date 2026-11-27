import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RequestUserInputCard, type RequestUserInputPayload } from './RequestUserInputCard'
import {
  createRequestUserInputAliasTracker,
  observeRequestUserInputAliases,
  requestUserInputRelatedKeysForPayloads,
} from './requestUserInputMessages'

const restored: RequestUserInputPayload = {
  kind: 'request_user_input', itemId: 'restored-item',
  threadId: 'thread', turnId: 'turn', appServerEpoch: 'current-server',
  questions: [{ id: 'choice', question: 'Continue?', options: [] }],
}
const live = { ...restored, requestId: 7, itemId: 'live-item' }

for (const field of ['threadId', 'turnId', 'appServerEpoch'] as const) {
  for (const terminal of ['resolved', 'response', 'requestUserInputResponse', 'request_user_input_response'] as const) {
    test(`an old ${field} ${terminal} cannot consume the current restoration slot`, () => {
      const historical = { ...restored, [field]: 'old',
        [terminal]: terminal === 'resolved' ? true : { itemId: restored.itemId, answers: {} } }
      const tracker = createRequestUserInputAliasTracker()
      observeRequestUserInputAliases(tracker, [historical, restored])
      observeRequestUserInputAliases(tracker, [historical, live])
      const keys = requestUserInputRelatedKeysForPayloads(tracker.previousPayloads,
        { ...live, answers: {} }, tracker.aliasesByKey)
      expect(keys).toContain('item:restored-item')
      // The alias cannot turn an old receipt into a reply for the current card.
      expect(requestUserInputRelatedKeysForPayloads(tracker.previousPayloads,
        { ...restored, [field]: 'old', answers: {} }, tracker.aliasesByKey)).toEqual([])
    })
  }

  test(`restoring after an old ${field} retains the current draft and submits only on activation`, () => {
    const historical = { ...restored, [field]: 'old', resolved: true }
    const tracker = createRequestUserInputAliasTracker()
    observeRequestUserInputAliases(tracker, [historical, restored])
    const submit = vi.fn()
    const view = render(<RequestUserInputCard payload={restored} aliasesByKey={tracker.aliasesByKey}
      onSubmit={submit} />)
    const draft = screen.getByTestId('request-user-input-custom-choice')
    fireEvent.change(draft, { target: { value: 'Keep the current task answer' } })
    observeRequestUserInputAliases(tracker, [historical, live])
    view.rerender(<RequestUserInputCard payload={live} aliasesByKey={tracker.aliasesByKey}
      onSubmit={submit} />)
    expect.soft(screen.getByTestId('request-user-input-custom-choice')).toBe(draft)
    expect.soft(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('Keep the current task answer')
    expect(submit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
    expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      requestId: live.requestId, itemId: live.itemId, [field]: live[field],
      answers: { choice: { answers: ['Keep the current task answer'] } },
    }))
  })
}
