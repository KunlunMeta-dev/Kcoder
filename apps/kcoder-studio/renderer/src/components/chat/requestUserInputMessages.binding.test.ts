import { describe, expect, it } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  applyRequestUserInputResponseToMessages,
  insertUserMessageBeforeRequestUserInput,
} from './requestUserInputMessages'

const messages = [
  {
    id: 'assistant-questions',
    role: 'assistant',
    content: '',
    status: 'done',
    createdAt: '2026-11-02T22:00:00.000Z',
    blocks: [
      { id: 'first', type: 'tool', status: 'pending', toolName: 'AskUserQuestion',
        renderPayload: { kind: 'request_user_input', requestId: 41, itemId: 'question-first' } },
      { id: 'second', type: 'tool', status: 'pending', toolName: 'AskUserQuestion',
        renderPayload: { kind: 'request_user_input', requestId: 42, itemId: 'question-second' } },
    ],
  },
] as WorkbenchMessage[]

describe('question responses require an explicit correlation identity', () => {
  it.each([
    { answers: {} },
    { requestId: ' ', itemId: '', answers: {} },
  ])('leaves pending cards intact for an unbound response: %j', response => {
    const next = applyRequestUserInputResponseToMessages(messages, response)
    expect(next).toBe(messages)
    expect(next[0].blocks?.map(block => block.status)).toEqual(['pending', 'pending'])
  })

  it('does not attach an unbound response to an anonymous restored question', () => {
    const restored = [{ ...messages[0], blocks: [
      { ...messages[0].blocks![0], renderPayload: { kind: 'request_user_input' } },
    ] }] as WorkbenchMessage[]
    expect(applyRequestUserInputResponseToMessages(restored, { answers: {} })).toBe(restored)
  })

  it('appends an unbound user message without moving it before another question', () => {
    const reply = { id: 'user-answer', role: 'user', content: 'My answer', status: 'done',
      createdAt: '2026-11-02T22:00:01.000Z' } as WorkbenchMessage
    expect(insertUserMessageBeforeRequestUserInput(messages, reply, { answers: {} }))
      .toEqual([...messages, reply])
  })

  it.each([
    { requestId: 42, answers: {} },
    { request_id: '42', answers: {} },
    { itemId: 'question-second', answers: {} },
    { item_id: 'question-second', answers: {} },
  ])('keeps explicit current and legacy identities working: %j', response => {
    const next = applyRequestUserInputResponseToMessages(messages, response)
    expect(next[0].blocks?.map(block => block.status)).toEqual(['pending', 'done'])
  })
})
