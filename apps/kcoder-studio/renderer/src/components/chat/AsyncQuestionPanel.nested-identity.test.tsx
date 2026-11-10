import { act, render, screen, waitFor } from '@testing-library/react'
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
beforeEach(() => {
  bridge.request.mockReset()
  bridge.subscribe.mockResolvedValue(vi.fn())
})

async function fixture(initial: unknown = question) {
  let current = initial
  let answer: unknown
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    if (params.method === 'asyncQuestion/answer') return {
      threadId: address.threadId, accepted: true, duplicate: false, question: answer,
    }
    return { threadId: address.threadId, questions: [current] }
  })
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  return { replace: (value: unknown) => { current = value }, receipt: (value: unknown) => { answer = value } }
}

const invalidRecords: [string, AsyncQuestionRecord][] = [
  ['item', { ...question, questions: [question.questions[0], { ...question.questions[0], question: 'A different prompt?' }] }],
  ['option', { ...question, questions: [{ ...question.questions[0], options: [
    { id: 'option', label: 'First choice', description: '' },
    { id: 'option', label: 'Different choice', description: '' },
  ] }] }],
]

it.each(invalidRecords)('rejects duplicate %s identities before displaying ambiguous answer controls', async (_name, invalid) => {
  const f = await fixture(invalid)
  expect(screen.getByTestId('async-question-retry')).toBeEnabled()
  expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument()
  expect(screen.getByTestId('composer')).toBeEnabled()
  f.replace(question)
  await userEvent.click(screen.getByTestId('async-question-retry'))
  expect(await screen.findByTestId('async-question-card-question')).toBeInTheDocument()
})

it.each(invalidRecords)('retains the original draft and disables submission on duplicate %s refresh', async (_name, invalid) => {
  const f = await fixture()
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'Keep the answer for the original prompt')
  f.replace(invalid)
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(screen.getByTestId('async-question-retry')).toBeEnabled()
  expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
  expect(draft).toHaveValue('Keep the answer for the original prompt')
  expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
  expect(screen.getByTestId('composer')).toBeEnabled()
  f.replace(question)
  await userEvent.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
  expect(draft).toHaveValue('Keep the answer for the original prompt')
})

it.each(invalidRecords)('rejects duplicate %s identities in an answer receipt before replacing the original card', async (_name, invalid) => {
  const f = await fixture()
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'Keep the answer for the original prompt')
  f.receipt({ ...invalid, revision: 2, status: 'answer_saved' })
  await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await act(async () => {})
  expect(screen.getByTestId('async-question-submit-error')).toBeInTheDocument()
  expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
  expect(draft).toHaveValue('Keep the answer for the original prompt')
  expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(1)
})
