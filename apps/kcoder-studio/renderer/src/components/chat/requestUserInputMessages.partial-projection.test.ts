import { expect, test } from 'vitest'
import type { RequestUserInputPayload } from './RequestUserInputCard'
import {
  createRequestUserInputAliasTracker,
  isHiddenRequestUserInputBlock,
  observeRequestUserInputAliases,
  requestUserInputRelatedKeysForPayloads,
} from './requestUserInputMessages'

const questions = [{ id: 'choice', question: 'Continue?', options: [{ label: 'Yes' }] }]
const restored: RequestUserInputPayload[] = ['a', 'b'].map(id => ({
  kind: 'request_user_input', itemId: `restored-${id}`, questions,
}))
const live = restored.map((payload, index) => ({
  ...payload, requestId: index + 1, itemId: `live-${index + 1}`,
}))

for (const order of ['partial-first', 'complete-first', 'complete-after-sibling']) {
  test(`a partial duplicate cannot consume another restoration slot (${order})`, () => {
    const partial = { ...live[0], itemId: undefined }
    const current = order === 'complete-after-sibling'
      ? [partial, live[1], live[0]]
      : [...(order === 'partial-first' ? [partial, live[0]] : [live[0], partial]), live[1]]
    const tracker = createRequestUserInputAliasTracker()
    observeRequestUserInputAliases(tracker, restored)
    observeRequestUserInputAliases(tracker, current)

    for (let index = 0; index < live.length; index += 1) {
      const hidden = new Set(requestUserInputRelatedKeysForPayloads(
        current,
        { requestId: live[index].requestId, itemId: live[index].itemId, answers: {} },
        tracker.aliasesByKey
      ))
      expect(restored.map(renderPayload => isHiddenRequestUserInputBlock({
        id: renderPayload.itemId!, type: 'tool', toolName: 'AskUserQuestion',
        status: 'pending', renderPayload,
      }, hidden))).toEqual(restored.map((_, candidate) => candidate === index))
    }
  })
}

test('a partial live projection still restores its original card when no complete projection exists', () => {
  const tracker = createRequestUserInputAliasTracker()
  const partial = { ...live[0], itemId: undefined }
  observeRequestUserInputAliases(tracker, [restored[0]])
  observeRequestUserInputAliases(tracker, [partial])
  expect(requestUserInputRelatedKeysForPayloads([partial], {
    requestId: partial.requestId, answers: {},
  }, tracker.aliasesByKey)).toContain('item:restored-a')
})

test('a historical item already shared with a live request keeps its restoration position', () => {
  const tracker = createRequestUserInputAliasTracker()
  const current = [
    { ...live[0], itemId: restored[0].itemId },
    live[1],
  ]
  observeRequestUserInputAliases(tracker, restored)
  observeRequestUserInputAliases(tracker, current)
  const related = requestUserInputRelatedKeysForPayloads(current, {
    requestId: current[0].requestId, itemId: current[0].itemId, answers: {},
  }, tracker.aliasesByKey)
  expect(related).toContain('item:restored-a')
  expect(related).not.toContain('item:restored-b')
})
