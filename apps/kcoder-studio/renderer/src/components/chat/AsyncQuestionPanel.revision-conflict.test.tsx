import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import { asyncQuestionRevisionFingerprint } from '../../../../shared/asyncQuestionRevision'
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
  questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false,
    options: [{ id: 'fast', label: 'Fast', description: '' },
      { id: 'careful', label: 'Careful', description: '' }] }],
}
beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset(); bridge.subscribe.mockReset(); bridge.subscribe.mockResolvedValue(() => undefined) })

async function fixture(initial = question) {
  let current = initial
  bridge.request.mockImplementation(async command => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    return { threadId: address.threadId, questions: [current] }
  })
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  if (initial.status === 'context_applied' || initial.status === 'cancelled' || initial.status === 'stale')
    await waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(2))
  else await userEvent.click(await screen.findByTestId('async-question-toggle'))
  return { replace: (record: AsyncQuestionRecord) => { current = record } }
}

it.each(['cancelled', 'stale', 'context_applied', 'delivery_failed', 'delivery_unknown'] as const)(
  'a higher list revision cannot reopen a %s question', async status => {
    const hidden = status === 'cancelled' || status === 'stale' || status === 'context_applied'
    const original: AsyncQuestionRecord = { ...question, revision: status === 'cancelled' || status === 'stale' ? 2 : 3, status,
      ...(status === 'delivery_failed' || status === 'delivery_unknown' ? { deliveryError: 'Original delivery diagnostic' } : {}),
      ...(['context_applied', 'delivery_failed', 'delivery_unknown'].includes(status) ? { answer: { submissionId: 'winner', acceptedAtMs: 2,
        answers: { item: { selectedOptionIds: ['fast'], text: 'Saved answer' } } } } : {}),
    }
    const f = await fixture(original)
    f.replace({ ...original, revision: original.revision + 1, status: original.answer ? 'queued' : 'pending', deliveryError: null })
    await act(async () => bridge.subscribe.mock.calls[0][0]({ event: 'async-question:changed', payload: { taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId } }))
    if (hidden) expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument()
    else expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', status)
    if (hidden) await userEvent.click(screen.getByTestId('async-question-toggle'))
    expect(screen.getByTestId('async-question-retry')).toBeEnabled()
    expect(screen.getByText(/Could not refresh this task’s question list/)).toBeVisible()
    expect(screen.queryByText(/Could not confirm which conversation owns/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('async-question-continue-delivery-question')).not.toBeInTheDocument()
    expect(screen.queryByTestId('request-user-input-submit-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeEnabled()
    f.replace(original)
    await userEvent.click(screen.getByTestId('async-question-retry'))
    await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
    if (hidden) expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument()
    else expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', status)
    expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
  }
)

it('a conflicting complete notification cannot prevent readback of a settled delivery failure', async () => {
  const failed: AsyncQuestionRecord = { ...question, revision: 3, status: 'delivery_failed',
    deliveryError: 'Original delivery error', answer: {
      submissionId: 'winner', acceptedAtMs: 2, answers: { item: { text: 'Saved answer' } },
    },
  }
  const f = await fixture(failed)
  const conflicting = { ...failed, revision: 4, status: 'stale', deliveryError: undefined } satisfies AsyncQuestionRecord
  f.replace(conflicting)
  await act(async () => bridge.subscribe.mock.calls[0][0]({ event: 'async-question:changed', payload: {
    taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
    questionId: conflicting.questionId, revision: conflicting.revision,
    revisionFingerprint: asyncQuestionRevisionFingerprint(conflicting),
  } }))
  expect(screen.getByTestId('async-question-retry')).toBeEnabled()
  expect(screen.getByText('Original delivery error')).toBeVisible()

  f.replace(failed)
  await userEvent.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
  expect(screen.getByText('Original delivery error')).toBeVisible()
  expect(screen.getByTestId('async-question-card-question')).toHaveTextContent(/Which mode\?: Saved answer/)
  expect(screen.getByTestId('composer')).toBeEnabled()
  expect(bridge.request.mock.calls.every(([, params]) => !params.method || params.method === 'asyncQuestion/list')).toBe(true)
})

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
  f.replace(question)
  await userEvent.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
  expect(draft).toHaveValue('Keep the original draft')
  expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
})

it('retains the confirmed delivery error when a newer snapshot rewrites it', async () => {
  const original: AsyncQuestionRecord = { ...question, revision: 3, status: 'delivery_failed',
    deliveryError: 'Original delivery error', answer: { submissionId: 'winner', acceptedAtMs: 2,
      answers: { item: { text: 'Saved answer' } } } }
  const f = await fixture(original)
  f.replace({ ...original, revision: 4, deliveryError: 'Different delivery error' })
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(await screen.findByTestId('async-question-retry')).toBeEnabled()
  expect(screen.getByText('Original delivery error')).toBeVisible()
  expect(screen.queryByText('Different delivery error')).not.toBeInTheDocument()
  expect(screen.getByTestId('composer')).toBeEnabled()
  f.replace(original)
  await userEvent.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
  expect(screen.getByText('Original delivery error')).toBeVisible()
  expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
})

it('keeps the confirmed delivery revision until the original answer is reconciled', async () => {
  const unknown: AsyncQuestionRecord = { ...question, revision: 3, status: 'delivery_unknown',
    deliveryError: 'Delivery outcome unknown', answer: { submissionId: 'winner', acceptedAtMs: 2,
      answers: { item: { text: 'Saved answer' } } } }
  const f = await fixture(unknown)
  f.replace({ ...unknown, revision: 5 })
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(await screen.findByTestId('async-question-retry')).toBeEnabled()
  expect(screen.getByText('Delivery outcome unknown')).toBeVisible()
  expect(screen.getByTestId('composer')).toBeEnabled()

  f.replace({ ...question, revision: 4, status: 'context_applied', answer: unknown.answer })
  await userEvent.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument())
  expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument()
  expect(bridge.request.mock.calls.every(([, params]) => !params.method || params.method === 'asyncQuestion/list')).toBe(true)
})

it('rejects a queued replay at revision 3 and recovers the applied answer', async () => {
  const queued: AsyncQuestionRecord = { ...question, revision: 2, status: 'queued',
    answer: { submissionId: 'winner', acceptedAtMs: 2, answers: { item: { text: 'Confirmed answer' } } } }
  const f = await fixture(queued)
  f.replace({ ...queued, revision: 3 })
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect.soft(screen.queryByTestId('async-question-retry')).toBeInTheDocument()
  expect(screen.getByText('Confirmed answer')).toBeVisible()
  expect(screen.getByTestId('composer')).toBeEnabled()

  f.replace({ ...queued, revision: 3, status: 'context_applied' })
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  await waitFor(() => expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument())
  expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument()
  expect(bridge.request.mock.calls.every(([, params]) => !params.method || params.method === 'asyncQuestion/list')).toBe(true)
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
  expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument()
})

it.each(['cancelled', 'stale'] as const)(
  'a newer %s snapshot cannot add an answer after unanswered settlement', async status => {
    const original: AsyncQuestionRecord = { ...question, revision: 2, status }
    const f = await fixture(original)
    f.replace({ ...original, revision: 3, answer: {
      submissionId: 'late-answer', acceptedAtMs: 3,
      answers: { item: { text: 'Answer added after settlement' } },
    } })
    await act(async () => bridge.subscribe.mock.calls[0][0]({ event: 'async-question:changed', payload: {
      taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
      questionId: question.questionId, revision: 3,
    } }))
    await userEvent.click(screen.getByTestId('async-question-toggle'))
    expect(screen.getByTestId('async-question-retry')).toBeEnabled()
    expect(screen.queryByText('Answer added after settlement')).not.toBeInTheDocument()
    expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeEnabled()
    f.replace(original)
    await userEvent.click(screen.getByTestId('async-question-retry'))
    await waitFor(() => expect(screen.queryByTestId('async-question-panel')).not.toBeInTheDocument())
    expect(bridge.request.mock.calls.every(([, params]) => !params.method || params.method === 'asyncQuestion/list')).toBe(true)
  }
)
