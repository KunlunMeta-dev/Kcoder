import { act, render, screen } from '@testing-library/react'
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

const address = { taskId: 'task', deviceId: 'server', threadId: 'thread' }
const question: AsyncQuestionRecord = {
  questionId: 'question', requestId: 'request', threadId: address.threadId,
  sourceTurnId: 'turn', toolCallId: 'tool', revision: 1, createdAtMs: 1,
  status: 'pending', questions: [{ id: 'item', header: 'Decision', question: 'Which mode?',
    multiSelect: false, options: [] }],
}

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => {
  vi.clearAllMocks()
  executor.subscribe.mockResolvedValue(vi.fn())
  executor.request.mockImplementation(async command => command === 'runtime.asyncQuestion.supports'
    ? { supported: true, threadId: address.threadId }
    : { threadId: address.threadId, questions: [question] })
})

it.each([
  ['/workspace/', '/workspace'],
  ['c:\\Work\\', 'C:/Work'],
])('an equivalent workspace projection preserves the draft (%s → %s)', async (original, alias) => {
  const user = userEvent.setup()
  const view = render(<AsyncQuestionPanel address={{ ...address, workspacePath: original }} />)
  await user.click(await screen.findByTestId('async-question-toggle'))
  const draft = screen.getByTestId('request-user-input-custom-item')
  await user.type(draft, 'Keep the original answer draft')
  const requests = executor.request.mock.calls.length
  await act(async () => view.rerender(<AsyncQuestionPanel address={{ ...address, workspacePath: alias }} />))
  expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
  expect(draft).toHaveValue('Keep the original answer draft')
  expect(executor.request).toHaveBeenCalledTimes(requests)
  await user.click(screen.getByTestId('async-question-refresh'))
  expect(executor.request.mock.calls.at(-1)?.[1]).toMatchObject({ workspacePath: original })
})

it('a genuinely different workspace clears the draft and reads its own question list', async () => {
  const user = userEvent.setup()
  const view = render(<AsyncQuestionPanel address={{ ...address, workspacePath: '/workspace' }} />)
  await user.click(await screen.findByTestId('async-question-toggle'))
  await user.type(screen.getByTestId('request-user-input-custom-item'), 'Original workspace draft')
  await act(async () => view.rerender(<AsyncQuestionPanel address={{ ...address, workspacePath: '/other' }} />))
  expect(await screen.findByTestId('request-user-input-custom-item')).toHaveValue('')
  expect(executor.request.mock.calls.at(-1)?.[1]).toMatchObject({ workspacePath: '/other' })
})

it('an answer waiting for its receipt remains owned after an equivalent workspace update', async () => {
  let finish!: () => void
  executor.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    if (params.method === 'asyncQuestion/list') return { threadId: address.threadId, questions: [question] }
    return new Promise(resolve => {
      finish = () => resolve({ threadId: address.threadId, accepted: true, duplicate: false,
        question: { ...question, status: 'context_applied', revision: 2,
          answer: { submissionId: params.params.submissionId, answers: params.params.answers, acceptedAtMs: 2 } } })
    })
  })
  const user = userEvent.setup()
  const view = render(<AsyncQuestionPanel address={{ ...address, workspacePath: '/workspace/' }} />)
  await user.click(await screen.findByTestId('async-question-toggle'))
  await user.type(screen.getByTestId('request-user-input-custom-item'), 'Original answer')
  await user.click(screen.getByTestId('request-user-input-submit-button'))
  await act(async () => view.rerender(<AsyncQuestionPanel address={{ ...address, workspacePath: '/workspace' }} />))
  try {
    expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
    expect(executor.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(1)
  } finally {
    await act(async () => finish())
  }
  expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', 'context_applied')
})
