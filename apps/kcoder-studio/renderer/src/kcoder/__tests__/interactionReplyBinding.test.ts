import { describe, expect, test } from 'vitest'
import { interactionReplyBinding } from '../interactionReplyBinding'

describe('interactionReplyBinding', () => {
  test('echoes every identity field a bound server requires', () => {
    expect(
      interactionReplyBinding({
        requiresBinding: true,
        approvalId: 'approval-2000000',
        threadId: 'thread-1',
        turnId: 'turn-1',
      })
    ).toEqual({
      ok: true,
      fields: {
        approvalId: 'approval-2000000',
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    })

    expect(
      interactionReplyBinding({
        requiresBinding: true,
        questionId: 'question-1000000',
        threadId: 'thread-1',
        turnId: 'turn-1',
      })
    ).toEqual({
      ok: true,
      fields: {
        questionId: 'question-1000000',
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    })
  })

  test('never guesses a binding when the server does not require one', () => {
    expect(
      interactionReplyBinding({
        requiresBinding: false,
        approvalId: 'approval-2000000',
        threadId: 'thread-1',
        turnId: 'turn-1',
      })
    ).toEqual({ ok: true, fields: {} })
  })

  test('reports an unusable identity instead of sending a doomed reply', () => {
    for (const input of [
      { requiresBinding: true, threadId: 'thread-1', turnId: 'turn-1' },
      { requiresBinding: true, approvalId: 'approval-1', turnId: 'turn-1' },
      { requiresBinding: true, approvalId: 'approval-1', threadId: 'thread-1' },
      { requiresBinding: true, approvalId: '  ', threadId: 'thread-1', turnId: 'turn-1' },
      {
        requiresBinding: true,
        approvalId: 'approval-1',
        questionId: 'question-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    ]) {
      const result = interactionReplyBinding(input)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0)
    }
  })
})
