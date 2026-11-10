import { Component, type ReactNode } from 'react'
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
class ConversationBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    return this.state.failed ? <div data-testid="conversation-crashed" /> : this.props.children
  }
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
  render(<ConversationBoundary><AsyncQuestionPanel address={address} /><input data-testid="composer" /></ConversationBoundary>)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  return { replace: (value: unknown) => { current = value }, receipt: (value: unknown) => { answer = value } }
}

it('an invalid initial question record exposes recovery without crashing the conversation', async () => {
  await fixture({ ...question, questions: null })
  expect(screen.queryByTestId('conversation-crashed')).not.toBeInTheDocument()
  expect(screen.getByTestId('async-question-retry')).toBeEnabled()
  expect(screen.getByTestId('composer')).toBeEnabled()
})

it.each([
  ['zero revision', { ...question, revision: 0 }],
  ['empty item list', { ...question, questions: [] }],
  ['too many items', { ...question, questions: Array.from({ length: 9 }, (_, index) => ({ ...question.questions[0], id: `item-${index}` })) }],
])('an initial %s cannot open an answer card and a valid read recovers', async (_name, invalid) => {
  const f = await fixture(invalid)
  expect(screen.getByTestId('async-question-retry')).toBeEnabled()
  expect(screen.queryByTestId('request-user-input-submit-button')).not.toBeInTheDocument()
  expect(screen.getByTestId('composer')).toBeEnabled()
  f.replace(question)
  await userEvent.click(screen.getByTestId('async-question-retry'))
  expect(await screen.findByTestId('request-user-input-custom-item')).toBeEnabled()
  expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
})

it.each([
  ['items', { ...question, questions: null }],
  ['options', { ...question, questions: [{ ...question.questions[0], options: null }] }],
  ['status', { ...question, status: null }],
  ['zero revision', { ...question, revision: 0 }],
])('an invalid %s refresh retains the last valid question and draft', async (_name, invalid) => {
  const f = await fixture()
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'Keep my original answer')
  f.replace(invalid)
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(screen.queryByTestId('conversation-crashed')).not.toBeInTheDocument()
  expect(screen.getByTestId('async-question-retry')).toBeEnabled()
  expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
  expect(draft).toHaveValue('Keep my original answer')
  expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
  expect(screen.getByTestId('composer')).toBeEnabled()
  f.replace(question)
  await userEvent.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
  expect(draft).toHaveValue('Keep my original answer')
})

it('a zero-revision answer receipt preserves the draft without confirming or replaying it', async () => {
  await fixture()
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'Keep my original answer')
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    if (params.method === 'asyncQuestion/answer') return {
      threadId: address.threadId, accepted: true, duplicate: false,
      question: { ...question, revision: 0, status: 'queued', answer: {
        submissionId: params.params.submissionId, acceptedAtMs: 2, answers: params.params.answers,
      } },
    }
    return { threadId: address.threadId, questions: [question] }
  })
  await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() => expect(screen.getByTestId('async-question-submit-error')).toBeInTheDocument())
  expect(draft).toHaveValue('Keep my original answer')
  expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', 'pending')
  expect(screen.queryByTestId('async-question-authoritative-answer-question')).not.toBeInTheDocument()
  expect(screen.getByTestId('composer')).toBeEnabled()
  expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(1)
})

it('a malformed answer receipt cannot replace the card or clear its draft', async () => {
  const f = await fixture()
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'Keep my original answer')
  f.receipt({ ...question, revision: 2, status: 'answer_saved', questions: null })
  await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await act(async () => {})
  expect(screen.queryByTestId('conversation-crashed')).not.toBeInTheDocument()
  expect(screen.getByTestId('async-question-submit-error')).toBeInTheDocument()
  expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
  expect(draft).toHaveValue('Keep my original answer')
  expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled()
  expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(1)
})
