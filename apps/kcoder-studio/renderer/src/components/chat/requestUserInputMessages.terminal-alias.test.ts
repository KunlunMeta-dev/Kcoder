import { describe, expect, it } from 'vitest'
import type { RequestUserInputPayload } from './RequestUserInputCard'
import {
  createRequestUserInputAliasTracker,
  isHiddenRequestUserInputBlock,
  observeRequestUserInputAliases,
  requestUserInputRelatedKeysForPayloads,
} from './requestUserInputMessages'

const questions = [{ id: 'choice', question: 'Continue?', options: [{ label: 'Yes' }] }]
const restored: RequestUserInputPayload = {
  kind: 'request_user_input', itemId: 'historical-item', questions,
}
const live: RequestUserInputPayload = {
  kind: 'request_user_input', requestId: 9, itemId: 'current-item', questions,
}
const oldAnswer = { itemId: restored.itemId, answers: { choice: { answers: ['Yes'] } } }

describe('restoration aliases preserve terminal question boundaries', () => {
  it.each(['response', 'requestUserInputResponse', 'request_user_input_response'] as const)(
    'an answered historical %s cannot bind a later identical live question', field => {
      const historical = { ...restored, [field]: oldAnswer }
      const tracker = createRequestUserInputAliasTracker()
      observeRequestUserInputAliases(tracker, [historical])
      observeRequestUserInputAliases(tracker, [historical, live])

      const hidden = new Set(requestUserInputRelatedKeysForPayloads(
        tracker.previousPayloads, oldAnswer, tracker.aliasesByKey
      ))
      expect.soft(tracker.aliasesByKey.size).toBe(0)
      expect(isHiddenRequestUserInputBlock({
        id: 'current', type: 'tool', toolName: 'AskUserQuestion', status: 'pending',
        renderPayload: live,
      }, hidden)).toBe(false)
    }
  )

  it.each(['response', 'requestUserInputResponse', 'request_user_input_response'] as const)(
    'a newly observed %s supersedes the previous unanswered restoration', field => {
      const tracker = createRequestUserInputAliasTracker()
      observeRequestUserInputAliases(tracker, [restored])
      observeRequestUserInputAliases(tracker, [{ ...restored, [field]: oldAnswer }, live])
      expect(tracker.aliasesByKey.size).toBe(0)
    }
  )

  it('an answered live projection cannot consume the alias of a pending restoration', () => {
    const tracker = createRequestUserInputAliasTracker()
    const answered = { ...live, response: {
      requestId: live.requestId, itemId: live.itemId, answers: {},
    } }
    const pending = { ...live, requestId: 10, itemId: 'pending-item' }
    observeRequestUserInputAliases(tracker, [restored])
    observeRequestUserInputAliases(tracker, [answered, restored, pending])

    const keys = requestUserInputRelatedKeysForPayloads(tracker.previousPayloads, {
      requestId: pending.requestId, itemId: pending.itemId, answers: {},
    }, tracker.aliasesByKey)
    expect(keys).toContain('item:historical-item')
    expect(keys).not.toContain('request:9')
    expect(keys).not.toContain('item:current-item')
  })

  it('a reused transport ID with a different item remains eligible for restoration', () => {
    const tracker = createRequestUserInputAliasTracker()
    const answered = { ...live, itemId: 'completed-item', response: {
      requestId: live.requestId, itemId: 'completed-item', answers: {},
    } }
    observeRequestUserInputAliases(tracker, [answered, restored])
    observeRequestUserInputAliases(tracker, [answered, live])
    expect(requestUserInputRelatedKeysForPayloads(tracker.previousPayloads, {
      requestId: live.requestId, itemId: live.itemId, answers: {},
    }, tracker.aliasesByKey)).toContain('item:historical-item')
  })

  it('keeps an original restoration alias after that question is answered', () => {
    const tracker = createRequestUserInputAliasTracker()
    observeRequestUserInputAliases(tracker, [restored])
    observeRequestUserInputAliases(tracker, [live])
    const original = new Map(tracker.aliasesByKey)
    observeRequestUserInputAliases(tracker, [{ ...live, response: {
      requestId: live.requestId, itemId: live.itemId, answers: {},
    } }])
    expect(tracker.aliasesByKey).toEqual(original)
  })
})
