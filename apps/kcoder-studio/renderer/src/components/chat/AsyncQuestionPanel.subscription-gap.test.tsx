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
  let activate!: () => void
  const stop = vi.fn()
  // Native event registration is asynchronous. No change event is received
  // before registration completes, even if the first snapshot already arrived.
  executor.subscribe.mockImplementation(() => new Promise(resolve => {
    activate = () => resolve(stop)
  }))
  let authoritative = pending
  executor.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports')
      return { supported: true, threadId: address.threadId }
    expect(params.method).toBe('asyncQuestion/list')
    return { threadId: address.threadId, questions: [authoritative] }
  })
  const view = render(<AsyncQuestionPanel address={address} />)
  return { view, activate: () => activate(), stop,
    settle: () => { authoritative = { ...pending, revision: 2, status: 'cancelled' } } }
}

it('reconciles a question answered or cancelled before event registration completed', async () => {
  const f = fixture()
  await screen.findByTestId('async-question-card-question')
  f.settle()
  await act(async () => { f.activate() })
  await waitFor(() => expect(screen.getByTestId('async-question-card-question'))
    .toHaveAttribute('data-status', 'cancelled'))
  expect(executor.request).toHaveBeenCalledTimes(3)
})

it('retains the original draft and exposes a failed post-registration reconciliation', async () => {
  const f = fixture()
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'Keep this unfinished answer')
  executor.request.mockRejectedValueOnce(new Error('list unavailable'))
  await act(async () => { f.activate() })
  await screen.findByTestId('async-question-retry')
  expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
  expect(draft).toHaveValue('Keep this unfinished answer')
  expect(executor.request).toHaveBeenCalledTimes(3)
})

it('does not refresh an unmounted task when its old registration completes', async () => {
  const f = fixture()
  await screen.findByTestId('async-question-card-question')
  f.view.unmount()
  await act(async () => { f.activate() })
  expect(executor.request).toHaveBeenCalledTimes(2)
  expect(f.stop).toHaveBeenCalled()
})
