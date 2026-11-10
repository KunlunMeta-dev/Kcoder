import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'

const bridge = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: bridge.request,
  subscribeLocalExecutorEvents: async () => () => undefined,
}))
const address = { taskId: 'task', deviceId: 'server', threadId: 'thread' }
const question: AsyncQuestionRecord = {
  questionId: 'question', requestId: 'request', threadId: address.threadId,
  sourceTurnId: 'turn', toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false, options: [] }],
}
beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset() })

it.each([
  ['accepted', undefined], ['accepted', null], ['accepted', 'true'],
  ['duplicate', undefined], ['duplicate', null], ['duplicate', 'false'],
])('rejects malformed %s=%j without discarding the original answer', async (field, value) => {
  let repaired = false
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    if (params.method === 'asyncQuestion/answer') {
      const receipt = {
        threadId: address.threadId, accepted: true, duplicate: false,
        question: { ...question, revision: 2, status: 'context_applied', answer: {
          submissionId: params.params.submissionId,
          answers: structuredClone(params.params.answers), acceptedAtMs: 2,
        } },
      }
      // A mistyped acceptance must not be treated as a competing device's win.
      if (!repaired) return { ...receipt, [field]: value, question: field === 'duplicate' ? receipt.question : {
        ...receipt.question, answer: { submissionId: 'unconfirmed-submission',
          answers: { item: { text: 'Unconfirmed replacement' } }, acceptedAtMs: 2 },
      } }
      return receipt
    }
    return { threadId: address.threadId, questions: [question] }
  })
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'My original answer')
  await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(await screen.findByTestId('async-question-submit-error')).toBeInTheDocument()
  expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
  expect(draft).toHaveValue('My original answer')
  expect(screen.queryByText('Unconfirmed replacement')).not.toBeInTheDocument()
  expect(screen.getByTestId('composer')).toBeEnabled()
  const answers = () => bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')
  expect(answers()).toHaveLength(1)

  // Recovery reads do not submit again. Only a deliberate retry may do so,
  // retaining the original submission identity for an uncertain outcome.
  repaired = true
  await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
  await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() => expect(screen.queryByTestId('request-user-input-custom-item')).not.toBeInTheDocument())
  expect(answers()).toHaveLength(2)
  expect(answers()[1][1].params.submissionId).toBe(answers()[0][1].params.submissionId)
  expect(screen.getByTestId('async-question-card-question')).toHaveTextContent('My original answer')
})
