import { act, render, screen } from '@testing-library/react'
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
  questions: [{ id: 'item', header: 'Note', question: 'Any details?', multiSelect: false, options: [] }],
}
const saved: AsyncQuestionRecord = { ...question, revision: 2, status: 'queued', answer: {
  submissionId: 'original', acceptedAtMs: 2,
  answers: { item: { selectedOptionIds: [], text: 'Keep my draft' } },
} }

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset() })

async function fixture(revision: number, initial = question, duplicate = false) {
  let receipt: AsyncQuestionRecord | undefined
  let completeRead: ((result: unknown) => void) | undefined
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    if (params.method === 'asyncQuestion/answer') {
      receipt = { ...saved, revision, status: !duplicate && revision >= 4 ? 'answer_saved' : 'queued', answer: { ...saved.answer!,
        submissionId: params.params.submissionId, answers: structuredClone(params.params.answers),
      } }
      return { threadId: address.threadId, accepted: true, duplicate, question: receipt }
    }
    if (receipt) return new Promise(resolve => { completeRead = resolve })
    return { threadId: address.threadId, questions: [initial] }
  })
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  if (initial.status === 'pending') {
    await userEvent.type(screen.getByTestId('request-user-input-custom-item'), 'Keep my draft')
    await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
  } else await userEvent.click(screen.getByTestId('async-question-continue-delivery-question'))
  return {
    recover: async () => {
      if (!completeRead) return
      await act(async () => completeRead!({ threadId: address.threadId,
        questions: [{ ...receipt!, revision: 4, status: 'context_applied' }] }))
    },
    answerCalls: () => bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer'),
  }
}

it.each([0, 1])('a first-save receipt at revision %s cannot confirm the revision-1 draft', async revision => {
  const f = await fixture(revision)
  try {
    expect(screen.getByTestId('async-question-submit-error')).toBeInTheDocument()
    expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', 'pending')
    expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
    expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
    expect(screen.getByTestId('composer')).toBeEnabled()
  } finally { await f.recover() }
  expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument()
  expect(f.answerCalls()).toHaveLength(1)
})

it.each([2, 3])('a continuation cannot accept a nonduplicate receipt at revision %s without advancing', async revision => {
  const f = await fixture(revision, saved)
  try {
    expect(screen.getByTestId('async-question-submit-error')).toBeInTheDocument()
    expect(screen.getByTestId('async-question-continue-delivery-question')).toBeDisabled()
    expect(screen.getByTestId('composer')).toBeEnabled()
  } finally { await f.recover() }
  expect(f.answerCalls()).toHaveLength(1)
})

it('rechecks the original task when a duplicate receipt contradicts the confirmed queued revision', async () => {
  const f = await fixture(3, saved, true)
  try {
    expect(screen.getByTestId('async-question-submit-error')).toBeInTheDocument()
    expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', 'queued')
    expect(screen.getByTestId('async-question-continue-delivery-question')).toBeDisabled()
    expect(screen.getByTestId('composer')).toBeEnabled()
  } finally { await f.recover() }
  expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument()
  expect(f.answerCalls()).toHaveLength(1)
})

it('accepts an exact saved-answer retry at the confirmed queued revision', async () => {
  const f = await fixture(saved.revision, saved, true)
  expect(screen.queryByTestId('async-question-submit-error')).not.toBeInTheDocument()
  expect(screen.getByTestId('async-question-continue-delivery-question')).toBeEnabled()
  expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', 'queued')
  expect(f.answerCalls()).toHaveLength(1)
})

it.each([4, 6])('a legacy answer_saved receipt may advance to revision %s', async revision => {
  const f = await fixture(revision)
  expect(screen.queryByTestId('async-question-submit-error')).not.toBeInTheDocument()
  expect(screen.queryByTestId('request-user-input-custom-item')).not.toBeInTheDocument()
  expect(screen.getByTestId('async-question-card-question')).toHaveTextContent('Keep my draft')
  expect(f.answerCalls()).toHaveLength(1)
})
