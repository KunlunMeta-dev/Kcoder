import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'

const executor = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: executor.request,
  subscribeLocalExecutorEvents: async () => () => undefined,
}))

const address = { taskId: 'original-task', deviceId: 'server', threadId: 'original-thread' }

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { executor.request.mockReset() })

it.each(['Deployment', ''])('shows every freeform prompt with header %j and answers its original item', async header => {
  const question: AsyncQuestionRecord = {
    questionId: 'question', requestId: 'request', threadId: address.threadId,
    sourceTurnId: 'source-turn', toolCallId: 'tool', revision: 1, createdAtMs: 1,
    status: 'pending', questions: [
      { id: 'environment', header, question: 'Which deployment environment should I use?',
        multiSelect: false, options: [] },
      { id: 'deadline', header, question: 'When must the deployment finish?',
        multiSelect: false, options: [] },
    ],
  }
  executor.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports')
      return { supported: true, threadId: address.threadId }
    if (params.method === 'asyncQuestion/list')
      return { threadId: address.threadId, questions: [question] }
    expect(params.method).toBe('asyncQuestion/answer')
    return { threadId: address.threadId, accepted: true, duplicate: false,
      question: { ...question, status: 'queued', revision: 2,
        answer: { submissionId: params.params.submissionId, acceptedAtMs: 2,
          answers: params.params.answers } } }
  })
  const user = userEvent.setup()
  render(<AsyncQuestionPanel address={address} />)
  await user.click(await screen.findByTestId('async-question-toggle'))
  const card = within(screen.getByTestId('async-question-card-question'))
  for (const item of question.questions) expect(card.getByText(item.question)).toBeVisible()
  await user.type(card.getByTestId('request-user-input-custom-environment'), 'staging')
  expect(card.getByTestId('request-user-input-submit-button')).toBeDisabled()
  await user.type(card.getByTestId('request-user-input-custom-deadline'), 'Friday')
  await user.click(card.getByTestId('request-user-input-submit-button'))
  const answers = executor.request.mock.calls.filter(([, params]) => params?.method === 'asyncQuestion/answer')
  expect(answers).toHaveLength(1)
  expect(answers[0][1]).toMatchObject({ taskId: address.taskId, params: {
    threadId: address.threadId, questionId: question.questionId, expectedRevision: 1,
    answers: { environment: { selectedOptionIds: [], text: 'staging' },
      deadline: { selectedOptionIds: [], text: 'Friday' } },
  } })
  expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', 'queued')
})
