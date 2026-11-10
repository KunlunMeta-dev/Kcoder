import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'

const bridge = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: bridge.request,
  subscribeLocalExecutorEvents: bridge.subscribe,
}))

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => {
  bridge.request.mockReset()
  bridge.subscribe.mockResolvedValue(vi.fn())
})

it.each(['pending', 'answer_saved'] as const)(
  'an initial %s record with 17 options requires recovery; 16 options remain answerable', async status => {
    const address = { taskId: 'task', deviceId: 'server', threadId: 'thread' }
    const valid: AsyncQuestionRecord = {
      questionId: 'question', requestId: 'request', threadId: address.threadId,
      sourceTurnId: 'turn', toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
      questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false,
        options: Array.from({ length: 16 }, (_, index) => ({
          id: `option-${index}`, label: `Mode ${index}`, description: '',
        })),
      }],
    }
    let current: AsyncQuestionRecord = {
      ...valid, status,
      questions: [{ ...valid.questions[0], options: [...valid.questions[0].options,
        { id: 'option-16', label: 'Invalid extra mode', description: '' }] }],
      ...(status === 'answer_saved' ? { answer: {
        submissionId: 'other-device', acceptedAtMs: 2,
        answers: { item: { selectedOptionIds: ['option-0'] } },
      } } : {}),
    }
    bridge.request.mockImplementation(async (command, params) => {
      if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
      if (params.method === 'asyncQuestion/answer') return {
        threadId: address.threadId, accepted: true, duplicate: false,
        question: { ...valid, revision: 2, status: 'answer_saved', answer: {
          submissionId: params.params.submissionId, answers: params.params.answers, acceptedAtMs: 2,
        } },
      }
      return { threadId: address.threadId, questions: [current] }
    })
    render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
    await userEvent.click(await screen.findByTestId('async-question-toggle'))
    expect(screen.getByTestId('async-question-retry')).toBeEnabled()
    expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeEnabled()

    current = valid
    await userEvent.click(screen.getByTestId('async-question-retry'))
    await userEvent.click(await screen.findByTestId('request-user-input-option-item-15'))
    await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
    await waitFor(() => expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', 'answer_saved'))
    const submissions = bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')
    expect(submissions).toHaveLength(1)
    expect(submissions[0][1].params.answers).toEqual({ item: { selectedOptionIds: ['option-15'] } })
  }
)
