import { render, screen } from '@testing-library/react'
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
  sourceTurnId: 'source', toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false, options: [] }],
}
beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset() })

async function answer(startedTurn: unknown) {
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    if (params.method === 'asyncQuestion/answer') return {
      threadId: address.threadId, accepted: true, duplicate: false, startedTurn,
      question: { ...question, revision: 2, status: 'context_applied', answer: {
        submissionId: params.params.submissionId,
        answers: structuredClone(params.params.answers), acceptedAtMs: 2,
      } },
    }
    return { threadId: address.threadId, questions: [question] }
  })
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'My original answer')
  await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(screen.getByTestId('composer')).toBeEnabled()
  expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(1)
  return draft
}

it.each([
  { id: 'answer-turn', status: 'running' },
  { id: 'answer-turn', turnId: 'answer-turn', status: 'running' },
  { id: 'answer-turn', threadId: address.threadId, status: 'running' },
])('accepts an unambiguous answer turn %j, including a legacy omitted task', async startedTurn => {
  await answer(startedTurn)
  expect(screen.queryByTestId('async-question-submit-error')).not.toBeInTheDocument()
  expect(screen.queryByTestId('request-user-input-custom-item')).not.toBeInTheDocument()
  expect(screen.getByTestId('async-question-card-question')).toHaveTextContent('My original answer')
})

it.each([
  { id: 'answer-turn', threadId: 'other-thread', status: 'running' },
  { id: 'answer-turn', threadId: address.threadId, turnId: 'peer-turn', status: 'running' },
  { id: 'answer-turn', turnId: 'peer-turn', status: 'running' },
  { id: 'answer-turn', threadId: null, status: 'running' },
  { id: '', status: 'running' },
  { id: '   ', status: 'running' },
  { id: '', threadId: address.threadId, status: 'running' },
  { id: '   ', threadId: address.threadId, status: 'running' },
  { status: 'running' },
  { id: 'answer-turn', status: 'unknown' },
])('rejects a misbound or invalid answer turn %j without consuming the draft', async startedTurn => {
  const draft = await answer(startedTurn)
  expect(await screen.findByTestId('async-question-submit-error')).toBeInTheDocument()
  expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
  expect(draft).toHaveValue('My original answer')
})
