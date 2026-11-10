import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'

const executor = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn(), servers: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: executor.request,
  subscribeLocalExecutorEvents: executor.subscribe,
}))
vi.mock('@/kcoder/gatewayRpc', () => ({ fetchGatewayServers: executor.servers }))

const address = { taskId: 'task', deviceId: 'account-scope-server', threadId: 'thread', workspacePath: '/owned' }
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
  executor.servers.mockResolvedValue([{ id: address.deviceId, transport: 'local', profile: 'original' }])
  executor.request.mockImplementation(async command => command === 'runtime.asyncQuestion.supports'
    ? { supported: true, threadId: address.threadId }
    : { threadId: address.threadId, questions: [question] })
})

async function editDraft() {
  const user = userEvent.setup()
  render(<AsyncQuestionPanel address={address} />)
  await user.click(await screen.findByTestId('async-question-toggle'))
  const draft = screen.getByTestId('request-user-input-custom-item')
  await user.type(draft, 'Original account answer')
  return { user, draft }
}

it.each(['account', 'target configuration'])('%s changes retire the old draft even when the task address is unchanged', async change => {
  const { draft } = await editDraft()
  const supportsBefore = executor.request.mock.calls.filter(([command]) => command === 'runtime.asyncQuestion.supports').length
  await act(async () => {
    if (change === 'account') notifyAccountContextChange(address.deviceId)
    else {
      executor.servers.mockResolvedValue([{ id: address.deviceId, transport: 'local', profile: 'replacement' }])
      window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: address.deviceId } }))
    }
  })
  await waitFor(() => expect(executor.request.mock.calls.filter(([command]) => command === 'runtime.asyncQuestion.supports'))
    .toHaveLength(supportsBefore + 1))
  await screen.findByTestId('async-question-card-question')
  await userEvent.click(screen.getByTestId('async-question-toggle'))
  expect(screen.getByTestId('request-user-input-custom-item')).not.toBe(draft)
  expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('')
  expect(executor.request.mock.calls.some(([, params]) => params?.method === 'asyncQuestion/answer')).toBe(false)
})

it('another target account change preserves this task draft and does not reread its questions', async () => {
  const { draft } = await editDraft()
  const reads = executor.request.mock.calls.length
  await act(async () => notifyAccountContextChange('unrelated-account-scope-server'))
  expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
  expect(draft).toHaveValue('Original account answer')
  expect(executor.request).toHaveBeenCalledTimes(reads)
})

it('account invalidation fences an old submit before React commits the replacement panel', async () => {
  await editDraft()
  const submit = screen.getByTestId('request-user-input-submit-button')
  await act(async () => {
    notifyAccountContextChange(address.deviceId)
    fireEvent.click(submit)
  })
  expect(executor.request.mock.calls.filter(([, params]) => params?.method === 'asyncQuestion/answer')).toHaveLength(0)
})

it.each([false, true])('an old account answer receipt cannot settle or refresh the replacement card (failure=%s)', async fails => {
  let finish!: () => void
  executor.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    if (params.method === 'asyncQuestion/list') return { threadId: address.threadId, questions: [question] }
    return new Promise((resolve, reject) => {
      finish = () => fails ? reject(new Error('original account receipt unavailable'))
        : resolve({ threadId: address.threadId, accepted: true, duplicate: false,
          question: { ...question, status: 'context_applied', revision: 2,
            answer: { submissionId: params.params.submissionId, answers: params.params.answers, acceptedAtMs: 2 } } })
    })
  })
  const { user } = await editDraft()
  await user.click(screen.getByTestId('request-user-input-submit-button'))
  await act(async () => notifyAccountContextChange(address.deviceId))
  await screen.findByTestId('async-question-card-question')
  const reads = executor.request.mock.calls.length
  await act(async () => finish())
  expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', 'pending')
  expect(screen.queryByTestId('async-question-submit-error')).not.toBeInTheDocument()
  expect(executor.request).toHaveBeenCalledTimes(reads)
  expect(executor.request.mock.calls.filter(([, params]) => params?.method === 'asyncQuestion/answer')).toHaveLength(1)
})
