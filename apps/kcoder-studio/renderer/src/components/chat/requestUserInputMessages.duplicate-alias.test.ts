import { expect, test } from 'vitest'
import type { RequestUserInputPayload } from './RequestUserInputCard'
import {
  createRequestUserInputAliasTracker,
  isHiddenRequestUserInputBlock,
  observeRequestUserInputAliases,
  requestUserInputRelatedKeysForPayloads,
} from './requestUserInputMessages'

test('duplicate live projections cannot consume a sibling restoration alias', () => {
  const questions = [{ id: 'choice', question: 'Continue?', options: [{ label: 'Yes' }] }]
  const restored: RequestUserInputPayload[] = ['a', 'b'].map(id => ({
    kind: 'request_user_input', itemId: `restored-${id}`, questions,
  }))
  const live = restored.map((payload, index) => ({
    ...payload, requestId: index + 1, itemId: `live-${index + 1}`,
  }))
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, restored)
  // The same live request can appear in both transcript and pending projections.
  observeRequestUserInputAliases(tracker, [live[0], { ...live[0] }, live[1]])

  for (let index = 0; index < live.length; index += 1) {
    const hidden = new Set(requestUserInputRelatedKeysForPayloads(
      tracker.previousPayloads,
      { requestId: live[index].requestId, itemId: live[index].itemId, answers: {} },
      tracker.aliasesByKey
    ))
    expect(restored.map(renderPayload => isHiddenRequestUserInputBlock({
      id: renderPayload.itemId!, type: 'tool', toolName: 'AskUserQuestion',
      status: 'pending', renderPayload,
    }, hidden))).toEqual(restored.map((_, candidate) => candidate === index))
  }
})
