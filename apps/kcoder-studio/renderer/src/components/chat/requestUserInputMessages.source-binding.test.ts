import { describe, expect, it } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import type { RequestUserInputPayload } from './RequestUserInputCard'
import {
  applyRequestUserInputResponseToMessages,
  createRequestUserInputAliasTracker,
  insertUserMessageBeforeRequestUserInput,
  isHiddenRequestUserInputBlock,
  observeRequestUserInputAliases,
  requestUserInputPayloadKeys,
  requestUserInputRelatedKeysForPayloads,
} from './requestUserInputMessages'

const source = {
  parentSessionId: 'parent',
  agentId: 'worker',
  backgroundRun: { parentSessionId: 'parent', agentId: 'worker', runId: 'run-1' },
}
const question = { id: 'choice', question: 'Continue?', options: [{ label: 'Yes' }] }
const payload = (
  sourceAgent?: RequestUserInputPayload['sourceAgent']
): RequestUserInputPayload => ({
  kind: 'request_user_input',
  requestId: 7,
  itemId: 'question-7',
  questions: [question],
  ...(sourceAgent ? { sourceAgent } : {}),
})
const sources = [
  undefined,
  source,
  { ...source, agentId: 'other' },
  { ...source, parentSessionId: 'other-parent' },
  { ...source, backgroundRun: { ...source.backgroundRun, runId: 'run-2' } },
  { ...source, backgroundRun: undefined },
]
const payloads = sources.map(payload)
const messages = payloads.map((renderPayload, index) => ({
  id: `message-${index}`,
  role: 'assistant',
  content: '',
  status: 'done',
  createdAt: '2026-11-04',
  blocks: [
    {
      id: `block-${index}`,
      type: 'tool',
      status: 'pending',
      toolName: 'AskUserQuestion',
      renderPayload,
    },
  ],
})) as WorkbenchMessage[]

describe('question presentation preserves exact source identity', () => {
  it.each(sources.map((sourceAgent, index) => ({ sourceAgent, index })))(
    'settles and hides only source $index when transport IDs are reused',
    ({ sourceAgent, index }) => {
      const response = { requestId: 7, itemId: 'question-7', sourceAgent, answers: {} }
      const next = applyRequestUserInputResponseToMessages(messages, response)
      expect(next.map(message => message.blocks![0].status)).toEqual(
        sources.map((_, candidate) => (candidate === index ? 'done' : 'pending'))
      )
      const hidden = new Set(requestUserInputRelatedKeysForPayloads(payloads, response))
      expect(
        messages.map(message => isHiddenRequestUserInputBlock(message.blocks![0], hidden))
      ).toEqual(sources.map((_, candidate) => candidate === index))
    }
  )

  it('inserts the answer before its source question, leaving later peers in place', () => {
    const answer = {
      id: 'answer',
      role: 'user',
      content: 'Yes',
      status: 'done',
      createdAt: '2026-11-04',
    } as WorkbenchMessage
    const next = insertUserMessageBeforeRequestUserInput(messages, answer, {
      requestId: 7,
      itemId: 'question-7',
      sourceAgent: source,
      answers: {},
    })
    expect(next.indexOf(answer)).toBe(1)
  })

  it('does not invent restoration aliases between identical questions from different sources', () => {
    const tracker = createRequestUserInputAliasTracker()
    observeRequestUserInputAliases(tracker, [
      { ...payload(), requestId: undefined, itemId: 'restored' },
    ])
    observeRequestUserInputAliases(tracker, [payload(source)])
    expect(tracker.aliasesByKey.size).toBe(0)
  })

  it('keeps same-source restoration aliases and legacy request/item spellings', () => {
    const restored = { ...payload(source), requestId: undefined, itemId: 'restored' }
    const tracker = createRequestUserInputAliasTracker()
    observeRequestUserInputAliases(tracker, [restored])
    observeRequestUserInputAliases(tracker, [payload(source)])
    const hidden = new Set(
      requestUserInputRelatedKeysForPayloads(
        [payload(source)],
        {
          request_id: '7',
          item_id: 'question-7',
          sourceAgent: structuredClone(source),
          answers: {},
        },
        tracker.aliasesByKey
      )
    )
    for (const key of requestUserInputPayloadKeys(restored)) expect(hidden.has(key)).toBe(true)
    for (const key of requestUserInputPayloadKeys(payload())) expect(hidden.has(key)).toBe(false)
  })
})
