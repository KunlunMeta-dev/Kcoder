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
  kind: 'request_user_input', itemId: `item-${id}`, questions,
}))
const live = restored.map((payload, index) => ({ ...payload, requestId: index + 1 }))

for (const current of [[live[1], live[0]], [live[1]]]) {
  test(`stable item identity takes priority over restoration order (${current.length} live)`, () => {
    const tracker = createRequestUserInputAliasTracker()
    observeRequestUserInputAliases(tracker, restored)
    observeRequestUserInputAliases(tracker, current)
    const hidden = new Set(requestUserInputRelatedKeysForPayloads(current, {
      requestId: live[1].requestId, itemId: live[1].itemId, answers: {},
    }, tracker.aliasesByKey))
    expect(restored.map(renderPayload => isHiddenRequestUserInputBlock({
      id: renderPayload.itemId!, type: 'tool', toolName: 'AskUserQuestion',
      status: 'pending', renderPayload,
    }, hidden))).toEqual([false, true])
    expect(hidden.has('request:1')).toBe(false)
  })
}

test('a stable match reserves its slot before a rebased sibling is paired', () => {
  const tracker = createRequestUserInputAliasTracker()
  const rebased = { ...live[0], itemId: 'rebased-a' }
  const current = [live[1], rebased]
  observeRequestUserInputAliases(tracker, restored)
  observeRequestUserInputAliases(tracker, current)
  for (const [index, payload] of [rebased, live[1]].entries()) {
    const hidden = new Set(requestUserInputRelatedKeysForPayloads(current, {
      requestId: payload.requestId, itemId: payload.itemId, answers: {},
    }, tracker.aliasesByKey))
    expect(restored.map(renderPayload => isHiddenRequestUserInputBlock({
      id: renderPayload.itemId!, type: 'tool', toolName: 'AskUserQuestion',
      status: 'pending', renderPayload,
    }, hidden))).toEqual(restored.map((_, candidate) => candidate === index))
  }
})

test('a stable alias still resolves a later request-only projection', () => {
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, restored)
  observeRequestUserInputAliases(tracker, [live[1]])
  const partial = { ...live[1], itemId: undefined }
  observeRequestUserInputAliases(tracker, [partial])
  expect(requestUserInputRelatedKeysForPayloads([partial], {
    requestId: partial.requestId, answers: {},
  }, tracker.aliasesByKey)).toEqual(['request:2', 'item:item-b'])
})

test('ambiguous stable identities cannot consume an unrelated restoration slot', () => {
  const tracker = createRequestUserInputAliasTracker()
  const conflicting = [live[1], { ...live[1], requestId: 3 }]
  observeRequestUserInputAliases(tracker, restored)
  observeRequestUserInputAliases(tracker, conflicting)
  expect(tracker.aliasesByKey.size).toBe(0)
  expect(requestUserInputRelatedKeysForPayloads(conflicting, {
    itemId: live[1].itemId, answers: {},
  }, tracker.aliasesByKey)).toEqual([])
})

test.each([0, 1])('a partial rebased snapshot cannot choose restoration slot %s by position', index => {
  const tracker = createRequestUserInputAliasTracker()
  const rebased = { ...live[index], itemId: `rebased-${index}` }
  observeRequestUserInputAliases(tracker, restored)
  // Recovery may publish only one of two identical pending questions first.
  // Its new item ID provides no evidence about the missing sibling's position.
  observeRequestUserInputAliases(tracker, [rebased])
  const hidden = new Set(requestUserInputRelatedKeysForPayloads([rebased], {
    requestId: rebased.requestId, itemId: rebased.itemId, answers: {},
  }, tracker.aliasesByKey))
  expect(restored.map(renderPayload => isHiddenRequestUserInputBlock({
    id: renderPayload.itemId!, type: 'tool', toolName: 'AskUserQuestion',
    status: 'pending', renderPayload,
  }, hidden))).toEqual([false, false])
  expect(tracker.aliasesByKey.size).toBe(0)
  expect(hidden).toEqual(new Set([`request:${rebased.requestId}`, `item:${rebased.itemId}`]))
})
