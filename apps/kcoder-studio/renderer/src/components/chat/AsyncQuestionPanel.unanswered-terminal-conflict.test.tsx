import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
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
  sourceTurnId: 'source', toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Note', question: 'Any details?', multiSelect: false, options: [] }],
}
const saved: AsyncQuestionRecord = { ...question, status: 'queued', revision: 3,
  answer: { submissionId: 'winner', acceptedAtMs: 2, answers: { item: { text: 'Original answer' } } } }

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => {
  bridge.request.mockReset()
  bridge.subscribe.mockReset().mockResolvedValue(vi.fn())
})

for (const status of ['cancelled', 'stale'] as const) {
  it.each(['terminal', 'answer'] as const)(
    `an older conflicting %s cannot silently reconcile an unanswered ${status} card`, async older => {
      const terminal = { ...question, revision: 3, status }
      const initial: AsyncQuestionRecord = older === 'answer' ? terminal
        : { ...saved, status: 'delivery_unknown', deliveryError: 'Unconfirmed delivery' }
      let current: AsyncQuestionRecord = initial
      bridge.request.mockImplementation(async command => command === 'runtime.asyncQuestion.supports'
        ? { supported: true, threadId: address.threadId }
        : { threadId: address.threadId, questions: [current] })
      render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
      if (older === 'terminal') await userEvent.click(await screen.findByTestId('async-question-toggle'))
      else await waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(2))
      current = { ...(older === 'answer' ? saved : terminal), revision: 2 }
      if (older === 'terminal') await userEvent.click(screen.getByTestId('async-question-refresh'))
      else await act(async () => bridge.subscribe.mock.calls[0][0]({ event: 'async-question:changed', payload: {
        taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
        questionId: question.questionId, revision: 4,
      } }))
      if (older === 'answer') await userEvent.click(screen.getByTestId('async-question-toggle'))
      expect(await screen.findByTestId('async-question-retry')).toBeEnabled()
      expect(screen.getByTestId('composer')).toBeEnabled()
      if (older === 'terminal') {
        expect(screen.getByText('Original answer')).toBeVisible()
        expect(screen.getByText('Unconfirmed delivery')).toBeVisible()
        expect(screen.queryByTestId('async-question-continue-delivery-question')).not.toBeInTheDocument()
      } else expect(screen.queryByText('Original answer')).not.toBeInTheDocument()
      current = initial
      if (older === 'answer') await act(async () => bridge.subscribe.mock.calls[0][0]({ event: 'async-question:changed', payload: {
      taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
    } }))
      else await userEvent.click(screen.getByTestId('async-question-retry'))
      await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
      expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
    },
  )
}
