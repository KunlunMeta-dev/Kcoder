import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'

const localExecutor = vi.hoisted(() => ({
  request: vi.fn(),
  subscribe: vi.fn(),
}))

vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: localExecutor.request,
  subscribeLocalExecutorEvents: localExecutor.subscribe,
}))

const address = { taskId: 'kcoder:server-a:thread-a', deviceId: 'server-a', threadId: 'thread-a' }

function pendingQuestion(): AsyncQuestionRecord {
  return {
    questionId: 'question-freeform',
    requestId: 'request-freeform',
    threadId: 'thread-a',
    sourceTurnId: 'turn-a',
    toolCallId: 'call-a',
    revision: 1,
    createdAtMs: 1,
    status: 'pending',
    questions: [{
      id: 'freeform',
      header: 'Answer',
      question: 'What should the task do?',
      multiSelect: false,
      options: [],
    }],
  } as AsyncQuestionRecord
}

describe('AsyncQuestionPanel pending freeform draft', () => {
  beforeAll(async () => {
    await createInstance().use(initReactI18next).init({
      lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
    })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localExecutor.subscribe.mockResolvedValue(vi.fn())
    localExecutor.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'runtime.asyncQuestion.supports') {
        return { taskId: params.taskId, threadId: address.threadId, supported: true }
      }
      if (method === 'runtime.asyncQuestion.request') {
        return { threadId: address.threadId, questions: [pendingQuestion()] }
      }
      throw new Error(`Unexpected renderer command ${method}`)
    })
  })

  it('keeps an unsubmitted freeform answer when Later collapses the pending question', async () => {
    const user = userEvent.setup()
    render(<AsyncQuestionPanel address={address} />)

    const toggle = await screen.findByTestId('async-question-toggle')
    await user.click(toggle)
    const answer = await screen.findByTestId('request-user-input-custom-freeform')
    await user.type(answer, 'Keep this pending answer')

    await user.click(screen.getByTestId('request-user-input-ignore-button'))
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await user.click(toggle)
    expect(screen.getByTestId('request-user-input-custom-freeform')).toHaveValue(
      'Keep this pending answer'
    )
    expect(screen.queryByTestId('async-question-show-dismissed')).not.toBeInTheDocument()
    expect(localExecutor.request.mock.calls.some(
      ([, params]) => (params as { method?: string }).method === 'asyncQuestion/answer'
    )).toBe(false)
  })
})
