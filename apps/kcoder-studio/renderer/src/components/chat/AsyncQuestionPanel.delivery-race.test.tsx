import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'

const executor = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: executor.request,
  subscribeLocalExecutorEvents: executor.subscribe,
}))

const address = { taskId: 'delivery-task', deviceId: 'delivery-server', threadId: 'delivery-thread' }

function savedQuestion(status: 'queued' | 'answer_saved', id = 'question-a'): AsyncQuestionRecord {
  return {
    questionId: id, requestId: `request-${id}`, threadId: address.threadId,
    sourceTurnId: 'source-turn', toolCallId: `tool-${id}`, revision: 3, createdAtMs: 1,
    status, questions: [{ id: 'item', header: 'Mode', question: 'Which mode?',
      multiSelect: false, options: [] }],
    answer: { submissionId: `submission-${id}`, acceptedAtMs: 2,
      answers: { item: { selectedOptionIds: [], text: ' original answer ' } } },
  }
}

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => {
  vi.clearAllMocks()
  executor.subscribe.mockResolvedValue(vi.fn())
})

async function fixture(questions: AsyncQuestionRecord[]) {
  const attempts: Array<{ input: Record<string, unknown>; finish(fail?: boolean): void }> = []
  executor.request.mockImplementation(async (_command, params) => {
    if (!params.method) return { threadId: address.threadId, supported: true }
    if (params.method === 'asyncQuestion/list') return { threadId: address.threadId, questions }
    if (params.method === 'asyncQuestion/answer') return new Promise((resolve, reject) => {
      const question = questions.find(value => value.questionId === params.params.questionId)!
      attempts.push({ input: structuredClone(params.params), finish: fail => fail
        ? reject(new Error('answer receipt unavailable'))
        : resolve({ threadId: address.threadId, question, accepted: true, duplicate: true }) })
    })
    throw new Error('Unexpected fixture operation')
  })
  render(<AsyncQuestionPanel address={address} />)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  const button = (id = 'question-a') => screen.getByTestId(`async-question-continue-delivery-${id}`)
  return { attempts, button }
}

it.each(['queued', 'answer_saved'] as const)(
  '%s delivery retries dispatch once when activated twice before React renders', async status => {
    const f = await fixture([savedQuestion(status)])
    try {
      act(() => { f.button().click(); f.button().click() })
      expect(f.attempts).toHaveLength(1)
      expect(f.button()).toBeDisabled()
    } finally {
      await act(async () => { f.attempts.forEach(attempt => attempt.finish()) })
    }
    expect(f.button()).toBeEnabled()
  }
)

it('a second activation cannot finish the first retry or unlock its pending card', async () => {
  const f = await fixture([savedQuestion('queued')])
  try {
    act(() => { f.button().click(); f.button().click() })
    // Settle only accidental duplicate work; the original receipt is still pending.
    await act(async () => { f.attempts.slice(1).forEach(attempt => attempt.finish(true)) })
    expect(f.button()).toBeDisabled()
    expect(f.attempts).toHaveLength(1)
  } finally {
    await act(async () => { f.attempts[0].finish() })
  }
  expect(f.button()).toBeEnabled()
})

it('failed delivery releases the guard for an explicit retry with the exact saved identity', async () => {
  const saved = savedQuestion('answer_saved')
  const f = await fixture([saved])
  await userEvent.click(f.button())
  await act(async () => { f.attempts[0].finish(true) })
  await waitFor(() => expect(f.button()).toBeEnabled())
  expect(screen.getByTestId('async-question-submit-error')).toBeInTheDocument()
  await userEvent.click(f.button())
  try {
    expect(f.attempts).toHaveLength(2)
    expect(f.attempts[1].input).toEqual(f.attempts[0].input)
    expect(f.attempts[1].input).toMatchObject({ submissionId: saved.answer!.submissionId,
      answers: saved.answer!.answers, expectedRevision: saved.revision })
    expect(f.button()).toBeDisabled()
  } finally {
    await act(async () => { f.attempts[1].finish() })
  }
})

it('each question owns its delivery guard and receipt independently', async () => {
  const f = await fixture([savedQuestion('queued'), savedQuestion('queued', 'question-b')])
  act(() => { f.button().click(); f.button('question-b').click() })
  try {
    expect(f.attempts.map(attempt => attempt.input.questionId)).toEqual(['question-a', 'question-b'])
    await act(async () => { f.attempts[0].finish() })
    expect(f.button()).toBeEnabled()
    expect(f.button('question-b')).toBeDisabled()
  } finally {
    await act(async () => { f.attempts.forEach(attempt => attempt.finish()) })
  }
})
