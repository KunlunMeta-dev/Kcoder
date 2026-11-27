import { expect, test } from 'vitest'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import type { WorkbenchMessage } from '@/types/workbench'
import type { RequestUserInputPayload } from './RequestUserInputCard'
import {
  createRequestUserInputAliasTracker,
  isRequestUserInputBlock,
  observeRequestUserInputAliases,
  requestUserInputRelatedKeysForPayloads,
} from './requestUserInputMessages'

test.each(['pending', 'terminal'] as const)('streamed body updates bound %s question identity and signature work to the observed payload count', state => {
  let questionReads = 0, identityReads = 0
  const payloads: RequestUserInputPayload[] = Array.from({ length: 24 }, (_, index) => ({
    kind: 'request_user_input', get itemId() { identityReads++; return `item-${index}` },
    requestId: index + 1, resolved: state === 'terminal',
    questions: [{ id: 'choice', get question() { questionReads++; return `Continue ${index}?` },
      options: [{ id: 'yes', label: 'Yes' }] }],
  }))
  let messages: WorkbenchMessage[] = payloads.map((renderPayload, index) => ({
    id: `question-${index}`, role: 'assistant', content: '', status: 'done',
    blocks: [{ id: `question-tool-${index}`, type: 'tool', toolName: 'AskUserQuestion',
      status: 'pending', renderPayload }],
  }))
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, payloads)
  questionReads = 0; identityReads = 0
  for (let update = 1; update <= 40; update++) {
    messages = reduceWorkbenchMessages(messages, { type: 'assistant_chunk',
      subtaskId: 'ongoing-turn', content: `Body ${update}` })
    const currentPayloads = messages.flatMap(message =>
      (message.blocks ?? []).filter(isRequestUserInputBlock).map(block => block.renderPayload))
    observeRequestUserInputAliases(tracker, currentPayloads)
  }
  expect(messages.at(-1)?.content).toContain('Body 40')
  // Previous and current projections both participate, without repeated per-group serialization.
  expect(questionReads).toBeLessThanOrEqual(40 * payloads.length * 2)
  expect(identityReads).toBeLessThanOrEqual(40 * payloads.length * 2)
  expect(tracker.previousPayloads.map(payload => payload.itemId)).toEqual(payloads.map(payload => payload.itemId))
  expect(tracker.aliasesByKey.size).toBe(0)
})

test('the next observation recomputes changed question semantics even for the same payload object', () => {
  const questions = [{ id: 'choice', question: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] }]
  const restored: RequestUserInputPayload = { kind: 'request_user_input', itemId: 'restored', questions }
  const live: RequestUserInputPayload = { ...restored, requestId: 1, itemId: 'live',
    questions: [{ ...questions[0], options: [{ id: 'different', label: 'Yes' }] }] }
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, [restored])
  observeRequestUserInputAliases(tracker, [live])
  expect(tracker.aliasesByKey.size).toBe(0)
  live.questions![0].options![0].id = 'yes'
  observeRequestUserInputAliases(tracker, [restored, live])
  expect(requestUserInputRelatedKeysForPayloads([restored, live],
    { requestId: 1, itemId: 'live', answers: {} }, tracker.aliasesByKey)).toContain('item:restored')
})


test('the next observation rebuilds identities and preserves the original turn fence', () => {
  const questions = [{ id: 'choice', question: 'Continue?', options: [{ label: 'Yes' }] }]
  const restored: RequestUserInputPayload = { kind: 'request_user_input', itemId: 'restored',
    threadId: 'thread', turnId: 'original-turn', appServerEpoch: 'epoch', questions }
  const live: RequestUserInputPayload = { ...restored, requestId: 1, itemId: 'previous-item', turnId: 'other-turn' }
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, [restored])
  observeRequestUserInputAliases(tracker, [live])
  expect(tracker.aliasesByKey.size).toBe(0)
  live.itemId = 'current-item'
  live.turnId = 'original-turn'
  observeRequestUserInputAliases(tracker, [restored, live])
  const keys = requestUserInputRelatedKeysForPayloads([restored, live],
    { requestId: 1, itemId: 'current-item', threadId: 'thread', turnId: 'original-turn', appServerEpoch: 'epoch', answers: {} },
    tracker.aliasesByKey)
  expect(keys).toContain('item:restored')
  expect(keys).toContain('item:current-item')
  expect(keys).not.toContain('item:previous-item')
})
