import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import type { LocalExecutorEvent } from '@/host/localExecutor'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'

const executor = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: executor.request,
  subscribeLocalExecutorEvents: executor.subscribe,
}))

const address = { taskId: 'task', deviceId: 'server', threadId: 'thread' }
const pending: AsyncQuestionRecord = {
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
beforeEach(() => { executor.request.mockReset(); executor.subscribe.mockReset() })

function fixture() {
  let fail!: () => void
  executor.subscribe.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    fail = () => reject(new Error('event registration unavailable'))
  }))
  let authoritative = pending
  executor.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports')
      return { supported: true, threadId: address.threadId }
    expect(params.method).toBe('asyncQuestion/list')
    return { threadId: address.threadId, questions: [authoritative] }
  })
  const view = render(<AsyncQuestionPanel address={address} />)
  return { view, fail: () => fail(),
    settle: () => { authoritative = { ...pending, revision: 2, status: 'cancelled' } } }
}

it('keeps an event registration failure visible after a successful list refresh and preserves the draft', async () => {
  const f = fixture()
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'Keep my answer')
  await act(async () => { f.fail() })
  expect(screen.getByTestId('async-question-retry')).toBeEnabled()
  executor.subscribe.mockRejectedValueOnce(new Error('still unavailable'))
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  await waitFor(() => expect(executor.subscribe).toHaveBeenCalledTimes(2))
  expect(screen.getByTestId('async-question-retry')).toBeEnabled()
  expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
  expect(draft).toHaveValue('Keep my answer')
})

it('retries registration once while pending, then receives later cross-device changes', async () => {
  const f = fixture()
  await screen.findByTestId('async-question-card-question')
  await act(async () => { f.fail() })
  let activate!: () => void
  let notify!: (event: LocalExecutorEvent) => void
  const stop = vi.fn()
  executor.subscribe.mockImplementationOnce(listener => new Promise(resolve => {
    notify = listener
    activate = () => resolve(stop)
  }))
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  await waitFor(() => expect(executor.subscribe).toHaveBeenCalledTimes(2))
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(executor.subscribe).toHaveBeenCalledTimes(2)
  await act(async () => { activate() })
  await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
  f.settle()
  await act(async () => { notify({ event: 'async-question:changed', payload: {
    taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
    questionId: pending.questionId, revision: 2,
  } }) })
  await waitFor(() => expect(screen.getByTestId('async-question-card-question'))
    .toHaveAttribute('data-status', 'cancelled'))
  expect(executor.request.mock.calls.every(([, params]) => !params.method || params.method === 'asyncQuestion/list')).toBe(true)
  f.view.unmount()
  expect(stop).toHaveBeenCalledOnce()
})

it('ignores a registration failure after the original task was unmounted', async () => {
  const f = fixture()
  await screen.findByTestId('async-question-card-question')
  f.view.unmount()
  const count = executor.request.mock.calls.length
  await act(async () => { f.fail() })
  expect(executor.request).toHaveBeenCalledTimes(count)
  expect(executor.subscribe).toHaveBeenCalledOnce()
})

it('disposes a retried listener that finishes after switching tasks without touching the new listener', async () => {
  const f = fixture()
  await screen.findByTestId('async-question-card-question')
  await act(async () => { f.fail() })
  let activate!: () => void
  const oldStop = vi.fn(), newStop = vi.fn()
  executor.subscribe.mockImplementationOnce(() => new Promise(resolve => {
    activate = () => resolve(oldStop)
  }))
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  await waitFor(() => expect(executor.subscribe).toHaveBeenCalledTimes(2))
  executor.subscribe.mockResolvedValueOnce(newStop)
  f.view.rerender(<AsyncQuestionPanel address={{ ...address, taskId: 'new-task' }} />)
  await waitFor(() => expect(executor.subscribe).toHaveBeenCalledTimes(3))
  await screen.findByTestId('async-question-card-question')
  const reads = executor.request.mock.calls.length
  await act(async () => { activate() })
  expect(oldStop).toHaveBeenCalledOnce()
  expect(newStop).not.toHaveBeenCalled()
  expect(executor.request).toHaveBeenCalledTimes(reads)
  expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument()
  f.view.unmount()
  expect(newStop).toHaveBeenCalledOnce()
})
