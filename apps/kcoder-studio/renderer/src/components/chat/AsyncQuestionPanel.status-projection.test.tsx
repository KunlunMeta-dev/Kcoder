import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'
import { ComposerStatusRegion } from './composer/ComposerStatusRegion'

const executor = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: executor.request,
  subscribeLocalExecutorEvents: executor.subscribe,
}))

const address = { taskId: 'status-task', deviceId: 'status-server', threadId: 'status-thread' }

function question(id: string, status: AsyncQuestionRecord['status'] = 'pending', revision = status === 'pending' ? 1 : 2): AsyncQuestionRecord {
  const itemId = `item-${id}`
  const savedAnswer = status !== 'pending' && status !== 'cancelled' && status !== 'stale'
  return {
    questionId: id,
    requestId: `request-${id}`,
    threadId: address.threadId,
    sourceTurnId: `turn-${id}`,
    toolCallId: `call-${id}`,
    revision,
    createdAtMs: 1,
    status,
    questions: [{
      id: itemId,
      header: 'Choice',
      question: `Which choice should ${id} use?`,
      multiSelect: false,
      options: [{ id: 'choice-a', label: 'Choice A', description: '' }],
    }],
    ...(savedAnswer ? {
      answer: {
        submissionId: `submission-${id}`,
        acceptedAtMs: 2,
        answers: { [itemId]: { selectedOptionIds: ['choice-a'] } },
      },
    } : {}),
    ...(status === 'delivery_failed' || status === 'delivery_unknown'
      ? { deliveryError: 'Delivery status needs review' }
      : {}),
  } as AsyncQuestionRecord
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

it('hides settled records while keeping active drafts and delivery attention through reconnect and resync', async () => {
  const user = userEvent.setup()
  let records = [
    question('question-draft'),
    question('question-second-draft'),
    question('question-cancelled'),
    question('question-stale'),
    question('question-completed'),
    question('question-saved', 'answer_saved'),
    question('question-queued', 'queued'),
    question('question-failed', 'delivery_failed', 3),
    question('question-unknown', 'delivery_unknown', 3),
  ]
  let failNextList = false
  let holdSupport = false
  let finishSupport: ((result: unknown) => void) | undefined
  executor.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
    if (command === 'runtime.asyncQuestion.supports') {
      if (holdSupport) return new Promise(resolve => { finishSupport = resolve })
      return { supported: true, threadId: address.threadId }
    }
    if (params.method === 'asyncQuestion/list') {
      if (failNextList) {
        failNextList = false
        throw new Error('temporary list failure')
      }
      return { threadId: address.threadId, questions: records }
    }
    throw new Error(`Unexpected renderer request ${String(params.method)}`)
  })

  render(<AsyncQuestionPanel address={address} />)
  await user.click(await screen.findByTestId('async-question-toggle'))
  const draft = await screen.findByTestId('request-user-input-custom-item-question-draft')
  const secondDraft = screen.getByTestId('request-user-input-custom-item-question-second-draft')
  await user.type(draft, 'Keep the first draft')
  await user.type(secondDraft, 'Keep the second draft')

  records = records.map(record => {
    if (record.questionId === 'question-cancelled') return question(record.questionId, 'cancelled', 2)
    if (record.questionId === 'question-stale') return question(record.questionId, 'stale', 2)
    if (record.questionId === 'question-completed') return question(record.questionId, 'context_applied', 3)
    return record
  })
  await user.click(screen.getByTestId('async-question-refresh'))

  await waitFor(() => {
    expect(screen.queryByTestId('async-question-card-question-cancelled')).not.toBeInTheDocument()
    expect(screen.queryByTestId('async-question-card-question-stale')).not.toBeInTheDocument()
    expect(screen.queryByTestId('async-question-card-question-completed')).not.toBeInTheDocument()
  })
  for (const [id, status] of [
    ['question-draft', 'pending'],
    ['question-second-draft', 'pending'],
    ['question-saved', 'answer_saved'],
    ['question-queued', 'queued'],
    ['question-failed', 'delivery_failed'],
    ['question-unknown', 'delivery_unknown'],
  ] as const) {
    expect(screen.getByTestId(`async-question-card-${id}`)).toHaveAttribute('data-status', status)
  }
  expect(screen.getByTestId('request-user-input-custom-item-question-draft')).toHaveValue('Keep the first draft')
  expect(screen.getByTestId('request-user-input-custom-item-question-second-draft'))
    .toHaveValue('Keep the second draft')
  expect(screen.getAllByText('Delivery status needs review')).toHaveLength(2)

  records = [...records, question('question-new')]
  const notify = executor.subscribe.mock.calls[0][0]
  await act(async () => notify({
    event: 'async-question:changed',
    payload: {
      taskId: address.taskId,
      serverId: address.deviceId,
      threadId: address.threadId,
      questionId: 'question-new',
      revision: 1,
    },
  }))
  expect(await screen.findByTestId('async-question-card-question-new')).toHaveAttribute('data-status', 'pending')
  expect(screen.queryByTestId('async-question-card-question-cancelled')).not.toBeInTheDocument()
  expect(screen.queryByTestId('async-question-card-question-stale')).not.toBeInTheDocument()
  expect(screen.queryByTestId('async-question-card-question-completed')).not.toBeInTheDocument()
  expect(draft).toHaveValue('Keep the first draft')
  expect(secondDraft).toHaveValue('Keep the second draft')

  holdSupport = true
  failNextList = true
  await act(async () => notify({
    event: 'async-question:refresh',
    payload: { taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId },
  }))
  await waitFor(() => expect(finishSupport).toBeTypeOf('function'))
  expect(screen.getByTestId('async-question-card-question-draft')).toBeInTheDocument()
  expect(screen.getByTestId('async-question-card-question-failed')).toBeInTheDocument()
  expect(screen.getByTestId('async-question-card-question-unknown')).toBeInTheDocument()
  expect(draft).toHaveValue('Keep the first draft')
  expect(secondDraft).toHaveValue('Keep the second draft')

  holdSupport = false
  await act(async () => finishSupport!({ supported: true, threadId: address.threadId }))
  await screen.findByTestId('async-question-retry')
  expect(screen.getByTestId('async-question-card-question-draft')).toBeInTheDocument()
  expect(screen.getByTestId('async-question-card-question-failed')).toBeInTheDocument()
  expect(screen.getByTestId('async-question-card-question-unknown')).toBeInTheDocument()
  expect(draft).toHaveValue('Keep the first draft')
  expect(secondDraft).toHaveValue('Keep the second draft')

  await user.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
  expect(screen.getByTestId('async-question-card-question-new')).toBeInTheDocument()
  expect(screen.queryByTestId('async-question-card-question-cancelled')).not.toBeInTheDocument()
  expect(screen.queryByTestId('async-question-card-question-stale')).not.toBeInTheDocument()
  expect(screen.queryByTestId('async-question-card-question-completed')).not.toBeInTheDocument()
  expect(draft).toHaveValue('Keep the first draft')
  expect(secondDraft).toHaveValue('Keep the second draft')
  expect(executor.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
})

it('uses the neutral question-status title when only saved answers need delivery attention', async () => {
  let records = [
    question('question-saved', 'answer_saved'),
    question('question-queued', 'queued'),
    question('question-failed', 'delivery_failed', 3),
    question('question-unknown', 'delivery_unknown', 3),
  ]
  executor.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
    if (command === 'runtime.asyncQuestion.supports')
      return { supported: true, threadId: address.threadId }
    if (params.method === 'asyncQuestion/list') return { threadId: address.threadId, questions: records }
    throw new Error(`Unexpected renderer request ${String(params.method)}`)
  })

  render(
    <ComposerStatusRegion>
      <AsyncQuestionPanel address={address} />
    </ComposerStatusRegion>
  )
  const trigger = await screen.findByTestId('composer-status-trigger-questions')
  expect(trigger).toHaveAttribute('title', expect.stringMatching(/^Question status/))

  records = [...records, question('question-pending')]
  await act(async () => executor.subscribe.mock.calls[0][0]({
    event: 'async-question:changed',
    payload: {
      taskId: address.taskId,
      serverId: address.deviceId,
      threadId: address.threadId,
      questionId: 'question-pending',
      revision: 1,
    },
  }))
  await waitFor(() => expect(trigger).toHaveAttribute('title', expect.stringMatching(/^Questions 1/)))
})

it('keeps the composer status region hidden until a question is confirmed', async () => {
  const user = userEvent.setup()
  let records: AsyncQuestionRecord[] = [{ ...question('invalid'), threadId: 'wrong-thread' }]
  executor.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports')
      return { supported: true, threadId: address.threadId }
    expect(params.method).toBe('asyncQuestion/list')
    expect(params.params.threadId).toBe(address.threadId)
    return { threadId: address.threadId, questions: records }
  })
  render(
    <ComposerStatusRegion>
      <AsyncQuestionPanel address={address} />
      <input data-testid="composer" />
    </ComposerStatusRegion>
  )
  await act(async () => {})
  expect(screen.queryByTestId('composer-status-trigger-questions')).not.toBeInTheDocument()
  expect(screen.queryByTestId('async-question-card-invalid')).not.toBeInTheDocument()
  await user.type(screen.getByTestId('composer'), 'Keep working')
  records = []
  await act(async () => executor.subscribe.mock.calls[0][0]({ event: 'async-question:refresh', payload: {
    taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
  } }))
  expect(screen.queryByTestId('composer-status-trigger-questions')).not.toBeInTheDocument()
  expect(screen.getByTestId('composer')).toHaveValue('Keep working')
  expect(executor.request.mock.calls.map(([command, params]) => params.method ?? command))
    .toEqual(['runtime.asyncQuestion.supports', 'asyncQuestion/list', 'runtime.asyncQuestion.supports', 'asyncQuestion/list'])
})
