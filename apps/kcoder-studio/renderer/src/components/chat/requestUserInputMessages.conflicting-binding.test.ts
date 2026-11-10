import { describe, expect, it } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  applyRequestUserInputResponseToMessages,
  insertUserMessageBeforeRequestUserInput,
  requestUserInputRelatedKeysForPayloads,
} from './requestUserInputMessages'

const payloads = [
  { kind: 'request_user_input', requestId: 41, itemId: 'question-first' },
  { kind: 'request_user_input', requestId: 42, itemId: 'question-second' },
]
const messages = payloads.map((renderPayload, index) => ({
  id: `assistant-${index}`, role: 'assistant', content: '', status: 'done', createdAt: '2026-11-03',
  blocks: [{ id: `block-${index}`, type: 'tool', status: 'pending',
    toolName: 'AskUserQuestion', renderPayload }],
})) as WorkbenchMessage[]

describe('question responses with conflicting correlation identities', () => {
  const response = { requestId: 41, itemId: 'question-second', answers: {} }

  it('cannot settle either of two different questions', () => {
    expect(applyRequestUserInputResponseToMessages(messages, response)).toBe(messages)
  })

  it('cannot move the answer before an unrelated question', () => {
    const reply = { id: 'reply', role: 'user', content: 'Answer', status: 'done',
      createdAt: '2026-11-03' } as WorkbenchMessage
    expect(insertUserMessageBeforeRequestUserInput(messages, reply, response))
      .toEqual([...messages, reply])
  })

  it('cannot hide either question through optimistic answered keys', () => {
    expect(requestUserInputRelatedKeysForPayloads(payloads, response)).toEqual([])
  })

  it.each([
    { kind: 'request_user_input', requestId: 41 },
    { kind: 'request_user_input', itemId: 'question-second' },
  ])('a legacy partial projection cannot certify contradictory identities: %j', partialPayload => {
    const restoredPayloads = [...payloads, partialPayload]
    const restoredMessages = [...messages, {
      ...messages[0], id: 'legacy-projection',
      blocks: [{ ...messages[0].blocks![0], renderPayload: partialPayload }],
    }] as WorkbenchMessage[]
    const reply = { id: 'reply', role: 'user', content: 'Answer', status: 'done',
      createdAt: '2026-11-03' } as WorkbenchMessage

    expect.soft(requestUserInputRelatedKeysForPayloads(restoredPayloads, response)).toEqual([])
    expect.soft(applyRequestUserInputResponseToMessages(restoredMessages, response))
      .toBe(restoredMessages)
    expect.soft(insertUserMessageBeforeRequestUserInput(restoredMessages, reply, response))
      .toEqual([...restoredMessages, reply])
  })

  it('preserves a previously registered restoration alias', () => {
    const aliases = new Map([['item:restored-second', new Set(['item:question-second'])]])
    expect(requestUserInputRelatedKeysForPayloads(payloads,
      { requestId: 42, itemId: 'restored-second', answers: {} }, aliases))
      .toEqual(['request:42', 'item:restored-second', 'item:question-second'])
  })

  it('keeps a complete matching binding authoritative when an older projection reuses one ID', () => {
    const reused = { ...payloads[0], requestId: 42 }
    const valid = { requestId: 42, itemId: 'question-second', answers: {} }
    expect(requestUserInputRelatedKeysForPayloads([...payloads, reused], valid))
      .toEqual(['request:42', 'item:question-second'])
  })

  it('accepts compatible partial legacy projections when no full binding contradicts them', () => {
    const legacy = [{ kind: 'request_user_input', requestId: 41 }]
    expect(requestUserInputRelatedKeysForPayloads(legacy,
      { requestId: 41, itemId: 'newly-resolved-item', answers: {} }))
      .toEqual(['request:41', 'item:newly-resolved-item'])
  })

  it.each([
    { requestId: 42, itemId: 'question-second', answers: {} },
    { request_id: '42', item_id: 'question-second', answers: {} },
    { requestId: 42, answers: {} },
    { itemId: 'question-second', answers: {} },
  ])('keeps consistent and legacy bindings working: %j', valid => {
    const next = applyRequestUserInputResponseToMessages(messages, valid)
    expect(next.map(message => message.blocks![0].status)).toEqual(['pending', 'done'])
  })
})
