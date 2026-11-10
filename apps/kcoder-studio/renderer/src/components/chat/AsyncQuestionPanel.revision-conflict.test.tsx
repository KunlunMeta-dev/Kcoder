import { act, render, screen, waitFor } from '@testing-library/react'
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
  questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false,
    options: [{ id: 'fast', label: 'Fast', description: '' },
      { id: 'careful', label: 'Careful', description: '' }] }],
}
beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset() })

async function fixture(initial = question) {
  let current = initial
  bridge.request.mockImplementation(async command => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    return { threadId: address.threadId, questions: [current] }
  })
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  return { replace: (record: AsyncQuestionRecord) => { current = record } }
}

it.each(['cancelled', 'stale', 'context_applied', 'delivery_failed', 'delivery_unknown'] as const)(
  'a higher list revision cannot reopen a %s question', async status => {
    const original: AsyncQuestionRecord = { ...question, revision: 2, status,
      ...(['context_applied', 'delivery_failed', 'delivery_unknown'].includes(status) ? { answer: { submissionId: 'winner', acceptedAtMs: 2,
        answers: { item: { selectedOptionIds: ['fast'], text: 'Saved answer' } } } } : {}),
    }
    const f = await fixture(original)
    f.replace({ ...original, revision: 3, status: original.answer ? 'queued' : 'pending' })
    await userEvent.click(screen.getByTestId('async-question-refresh'))
    expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', status)
    expect(screen.getByTestId('async-question-retry')).toBeEnabled()
    expect(screen.getByText(/Could not refresh this task’s question list/)).toBeVisible()
    expect(screen.queryByText(/Could not confirm which conversation owns/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('async-question-continue-delivery-question')).not.toBeInTheDocument()
    expect(screen.queryByTestId('request-user-input-submit-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeEnabled()
    f.replace(original)
    await userEvent.click(screen.getByTestId('async-question-retry'))
    await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
    expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', status)
    expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
  }
)

it.each(['prompt', 'status'] as const)('a conflicting same-revision %s list preserves the card and draft', async kind => {
  const f = await fixture()
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'Keep the original draft')
  f.replace(kind === 'prompt' ? { ...question, questions: [{ ...question.questions[0], question: 'A different question' }] }
    : { ...question, status: 'cancelled' })
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(screen.getByTestId('async-question-retry')).toBeEnabled()
  expect(draft).toHaveValue('Keep the original draft')
  expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
  expect(screen.getByTestId('composer')).toBeEnabled()
  f.replace({ ...question, revision: question.revision + 1 })
  await userEvent.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
  expect(draft).toHaveValue('Keep the original draft')
  expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
})

it('a competing-answer receipt cannot change the displayed revision without advancing it', async () => {
  await fixture()
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'Keep the original draft')
  const original = bridge.request.getMockImplementation()!
  bridge.request.mockImplementation(async (command, params) => {
    if (params?.method === 'asyncQuestion/answer') return {
      threadId: address.threadId, accepted: false, duplicate: false,
      question: { ...question, status: 'queued', answer: {
        submissionId: 'foreign-winner', acceptedAtMs: 2, answers: { item: { text: 'Foreign answer' } },
      } },
    }
    return original(command, params)
  })
  await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(await screen.findByTestId('async-question-submit-error')).toBeVisible()
  expect(draft).toHaveValue('Keep the original draft')
  expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', 'pending')
  expect(screen.queryByTestId('async-question-continue-delivery-question')).not.toBeInTheDocument()
  expect(screen.getByTestId('composer')).toBeEnabled()
})

it('a late competing-answer receipt cannot overwrite the same revision confirmed during submission', async () => {
  const f = await fixture()
  await userEvent.type(screen.getByTestId('request-user-input-custom-item'), 'My draft')
  const original = bridge.request.getMockImplementation()!
  let complete!: (value: unknown) => void
  bridge.request.mockImplementation((command, params) => params?.method === 'asyncQuestion/answer'
    ? new Promise(resolve => { complete = resolve }) : original(command, params))
  await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
  const winner: AsyncQuestionRecord = { ...question, revision: 2, status: 'queued', answer: {
    submissionId: 'winner', acceptedAtMs: 2, answers: { item: { text: 'Confirmed answer' } },
  } }
  f.replace(winner)
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(await screen.findByText('Confirmed answer')).toBeVisible()
  await act(async () => complete({ threadId: address.threadId, accepted: false, duplicate: false,
    question: { ...winner, answer: { ...winner.answer!, answers: { item: { text: 'Foreign answer' } } } },
  }))
  expect(screen.getByText('Confirmed answer')).toBeVisible()
  expect(screen.queryByText('Foreign answer')).not.toBeInTheDocument()
})

it.each([2, 3])('a conflicting receipt at revision %i in one React batch retains the confirmed answer', async revision => {
  await fixture()
  await userEvent.type(screen.getByTestId('request-user-input-custom-item'), 'My draft')
  const original = bridge.request.getMockImplementation()!
  let completeAnswer!: (value: unknown) => void
  let completeList!: (value: unknown) => void
  bridge.request.mockImplementation((command, params) => {
    if (params?.method === 'asyncQuestion/answer') return new Promise(resolve => { completeAnswer = resolve })
    if (params?.method === 'asyncQuestion/list') return new Promise(resolve => { completeList = resolve })
    return original(command, params)
  })
  await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  const winner: AsyncQuestionRecord = { ...question, revision: 2, status: 'queued', answer: {
    submissionId: 'winner', acceptedAtMs: 2, answers: { item: { text: 'Confirmed answer' } },
  } }
  await act(async () => {
    completeList({ threadId: address.threadId, questions: [winner] })
    completeAnswer({ threadId: address.threadId, accepted: false, duplicate: false,
      question: { ...winner, revision, answer: { ...winner.answer!, answers: { item: { text: 'Foreign answer' } } } },
    })
  })
  expect(screen.getByText('Confirmed answer')).toBeVisible()
  expect(screen.queryByText('Foreign answer')).not.toBeInTheDocument()
})

it.each(['submission', 'payload', 'missing answer', 'timestamp'])('a newer list cannot replace the saved %s', async change => {
  const f = await fixture()
  const winner: AsyncQuestionRecord = { ...question, revision: 2, status: 'queued', answer: {
    submissionId: 'winner', acceptedAtMs: 2, answers: { item: { text: 'Confirmed answer' } },
  } }
  f.replace(winner)
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(await screen.findByText('Confirmed answer')).toBeVisible()
  f.replace({ ...winner, revision: 3, status: 'context_applied',
    answer: change === 'missing answer' ? undefined : { ...winner.answer!,
      ...(change === 'submission' ? { submissionId: 'foreign-winner' } : {}),
      ...(change === 'timestamp' ? { acceptedAtMs: 99 } : {}),
      ...(change === 'payload' ? { answers: { item: { text: 'Foreign answer' } } } : {}),
    } })
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(await screen.findByTestId('async-question-retry')).toBeVisible()
  expect(screen.getByText('Confirmed answer')).toBeVisible()
  expect(screen.queryByText('Foreign answer')).not.toBeInTheDocument()
  f.replace({ ...winner, revision: 3, status: 'context_applied' })
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
  expect(screen.getByText('Confirmed answer')).toBeVisible()
})
