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

async function answer(startedTurn: unknown, status: AsyncQuestionRecord['status'] = 'context_applied') {
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    if (params.method === 'asyncQuestion/answer') return {
      threadId: address.threadId, accepted: true, duplicate: false, startedTurn,
      question: { ...question, revision: 3, status, answer: {
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
  { id: 'answer-turn', status: 'running', attemptId: null },
  { id: 'answer-turn', status: 'running', attemptId: 'answer-attempt' },
  { id: '\uFEFF', status: 'running' },
  { id: 'answer-turn', status: 'running', attemptId: '\uFEFF' },
  { id: 'answer-turn', turnId: 'answer-turn', status: 'running' },
  { id: 'answer-turn', threadId: address.threadId, status: 'running' },
])('accepts an unambiguous answer turn %j, including a legacy omitted task', async startedTurn => {
  await answer(startedTurn)
  expect(screen.queryByTestId('async-question-submit-error')).not.toBeInTheDocument()
  expect(screen.queryByTestId('request-user-input-custom-item')).not.toBeInTheDocument()
  expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument()
})

it.each([
  { id: 'answer-turn', threadId: 'other-thread', status: 'running' },
  { id: 'answer-turn', threadId: address.threadId, turnId: 'peer-turn', status: 'running' },
  { id: 'answer-turn', turnId: 'peer-turn', status: 'running' },
  { id: 'answer-turn', threadId: null, status: 'running' },
  { id: '', status: 'running' },
  { id: '   ', status: 'running' },
  { id: '\u0085', status: 'running' },
  { id: ' \u0085\t', threadId: address.threadId, status: 'running' },
  { id: '', threadId: address.threadId, status: 'running' },
  { id: '   ', threadId: address.threadId, status: 'running' },
  { status: 'running' },
  { id: 'answer-turn', status: 'unknown' },
  { id: 'answer-turn', status: 'completed' },
  { id: 'answer-turn', status: 'running', attemptId: '' },
  { id: 'answer-turn', status: 'running', attemptId: '   ' },
  { id: 'answer-turn', status: 'running', attemptId: '\u0085' },
  { id: 'answer-turn', status: 'running', attemptId: ' \u0085\t' },
])('rejects a misbound or invalid answer turn %j without consuming the draft', async startedTurn => {
  const draft = await answer(startedTurn)
  expect(await screen.findByTestId('async-question-submit-error')).toBeInTheDocument()
  expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
  expect(draft).toHaveValue('My original answer')
})

it.each(['stale', 'answer_saved'] as const)('keeps the draft when a %s receipt claims it started a turn', async status => {
  const draft = await answer({ id: 'answer-turn', status: 'running' }, status)
  expect(await screen.findByTestId('async-question-submit-error')).toBeInTheDocument()
  expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
  expect(draft).toHaveValue('My original answer')
  expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/list')).toHaveLength(2)
})

it('reads back the saved answer when an older duplicate claims a new turn', async () => {
  const savedOnly: AsyncQuestionRecord = {
    ...question, revision: 4, status: 'answer_saved',
    answer: { submissionId: 'saved', answers: { item: { text: 'Saved answer' } }, acceptedAtMs: 2 },
  }
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    if (params.method === 'asyncQuestion/answer') return {
      threadId: address.threadId, accepted: true, duplicate: true,
      question: { ...savedOnly, revision: 2, status: 'queued' },
      startedTurn: { id: 'answer-turn', threadId: address.threadId, status: 'running' },
    }
    return { threadId: address.threadId, questions: [savedOnly] }
  })

  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  await userEvent.click(screen.getByTestId('async-question-continue-delivery-question'))

  expect(await screen.findByTestId('async-question-submit-error')).toBeInTheDocument()
  expect(screen.getByTestId('async-question-authoritative-answer-question')).toHaveTextContent('Saved answer')
  expect(screen.getByTestId('composer')).toBeEnabled()
  expect(bridge.request.mock.calls.map(([, params]) => params.method).filter(Boolean)).toEqual([
    'asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/list',
  ])
})
