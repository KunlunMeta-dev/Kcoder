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
  sourceTurnId: 'source', toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Note', question: 'Any details?', multiSelect: false, options: [] }],
}
const saved: AsyncQuestionRecord = { ...question, status: 'queued', revision: 2,
  answer: { submissionId: 'winner', acceptedAtMs: 2, answers: { item: { text: 'Original answer' } } } }

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset() })

it.each(['context_applied', 'delivery_failed', 'delivery_unknown', 'cancelled', 'stale'] as const)(
  'does not reopen an applied answer when a late %s receipt arrives', async status => {
    let current: AsyncQuestionRecord = question
    let finishAnswer: (() => void) | undefined
    let listReads = 0
    bridge.request.mockImplementation(async (command, params) => {
      if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
      if (params.method === 'asyncQuestion/list') {
        listReads++
        return { threadId: address.threadId, questions: [current] }
      }
      if (params.method === 'asyncQuestion/answer') {
        const submitted = params.params
        return new Promise(resolve => {
          finishAnswer = () => resolve({ threadId: address.threadId, accepted: true, duplicate: false,
            question: { ...question, revision: 3, status,
              answer: { submissionId: submitted.submissionId, acceptedAtMs: 2, answers: submitted.answers },
              ...(status === 'delivery_failed' || status === 'delivery_unknown'
                ? { deliveryError: 'Original delivery diagnostic' } : {}) } })
        })
      }
      throw new Error(`Unexpected async-question request: ${params.method}`)
    })
    render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
    await userEvent.click(await screen.findByTestId('async-question-toggle'))
    await userEvent.type(screen.getByTestId('request-user-input-custom-item'), 'Original answer')
    const submit = userEvent.click(screen.getByTestId('request-user-input-submit-button'))
    await waitFor(() => expect(finishAnswer).toBeDefined())

    const submitted = bridge.request.mock.calls.find(([, params]) => params.method === 'asyncQuestion/answer')![1].params
    current = { ...question, revision: 4, status: 'context_applied',
      answer: { submissionId: submitted.submissionId, acceptedAtMs: 2, answers: submitted.answers } }
    const readsBeforeApplied = listReads
    await userEvent.click(screen.getByTestId('async-question-refresh'))
    await waitFor(() => expect(listReads).toBeGreaterThan(readsBeforeApplied))
    await waitFor(() => expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument())
    const readsAfterApplied = listReads

    await act(async () => { finishAnswer?.() })
    await submit
    if (status !== 'delivery_unknown')
      await waitFor(() => expect(listReads).toBeGreaterThan(readsAfterApplied))
    expect(screen.queryByTestId('async-question-toggle')).not.toBeInTheDocument()
    expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(1)
  },
)

it('rejects an inflated delivery revision and restores the other question on refresh', async () => {
  const delivered: AsyncQuestionRecord = { ...saved, revision: 4, status: 'context_applied' }
  const pending: AsyncQuestionRecord = { ...question, questionId: 'second', requestId: 'second-request', toolCallId: 'second-tool' }
  let current = delivered
  bridge.request.mockImplementation(async command => command === 'runtime.asyncQuestion.supports'
    ? { supported: true, threadId: address.threadId }
    : { threadId: address.threadId, questions: [current, pending] })
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  current = { ...delivered, revision: 5 }
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(await screen.findByTestId('async-question-retry')).toBeEnabled()
  expect(screen.getByTestId('composer')).toBeEnabled()
  current = delivered
  await userEvent.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
  expect(screen.getByTestId('async-question-card-second')).toBeVisible()
  expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
})

it.each([
  { revision: 4, status: 'stale' },
  { revision: 5, status: 'context_applied' },
] as const)('keeps unknown delivery visible on conflicting $status revision $revision', async conflict => {
  const unknown: AsyncQuestionRecord = { ...saved, revision: 3, status: 'delivery_unknown',
    deliveryError: 'Original delivery diagnostic' }
  let current = unknown
  bridge.request.mockImplementation(async command => command === 'runtime.asyncQuestion.supports'
    ? { supported: true, threadId: address.threadId }
    : { threadId: address.threadId, questions: [current] })
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  expect(await screen.findByText('Original answer')).toBeVisible()

  current = { ...saved, ...conflict }
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(await screen.findByTestId('async-question-retry')).toBeEnabled()
  expect(screen.getByText('Original answer')).toBeVisible()
  expect(screen.getByTestId('composer')).toBeEnabled()

  current = { ...saved, revision: 4, status: 'context_applied' }
  await userEvent.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
  expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument()
  expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
})

it('keeps the failed delivery visible when a refresh reports staleness', async () => {
  const failed: AsyncQuestionRecord = { ...saved, revision: 3, status: 'delivery_failed',
    deliveryError: 'Answer was not admitted' }
  let current = failed
  bridge.request.mockImplementation(async command => command === 'runtime.asyncQuestion.supports'
    ? { supported: true, threadId: address.threadId }
    : { threadId: address.threadId, questions: [current] })
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  expect(await screen.findByText('Original answer')).toBeVisible()

  current = { ...saved, revision: 4, status: 'stale' }
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(await screen.findByTestId('async-question-retry')).toBeEnabled()
  expect(screen.getByText('Original answer')).toBeVisible()
  expect(screen.getByTestId('composer')).toBeEnabled()

  current = failed
  await userEvent.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
  expect(screen.getByText('Original answer')).toBeVisible()
  expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
})

it('keeps the queued answer when refresh reports a newer saved-only state', async () => {
  let current = saved
  bridge.request.mockImplementation(async command => command === 'runtime.asyncQuestion.supports'
    ? { supported: true, threadId: address.threadId }
    : { threadId: address.threadId, questions: [current] })
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  expect(await screen.findByText('Original answer')).toBeVisible()

  current = { ...saved, revision: 4, status: 'answer_saved' }
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(await screen.findByTestId('async-question-retry')).toBeEnabled()
  expect(screen.getByText('Original answer')).toBeVisible()
  expect(screen.getByTestId('composer')).toBeEnabled()
  expect(screen.getByTestId('async-question-continue-delivery-question')).toBeDisabled()

  current = saved
  await userEvent.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
  expect(screen.getByTestId('async-question-continue-delivery-question')).toBeEnabled()
  expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
})
