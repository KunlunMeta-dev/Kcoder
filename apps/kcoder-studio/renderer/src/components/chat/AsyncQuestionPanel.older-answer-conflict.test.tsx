import { render, screen, waitFor } from '@testing-library/react'
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
  questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false, options: [] }],
}
const saved: AsyncQuestionRecord = { ...question, revision: 3, status: 'queued',
  answer: { submissionId: 'winner', acceptedAtMs: 2, answers: { item: { text: 'Confirmed answer' } } } }
beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset() })

it.each(['submission', 'payload', 'timestamp'] as const)(
  'an older list with a conflicting saved %s preserves the winner and requires recovery', async change => {
    let current = saved
    bridge.request.mockImplementation(async command => command === 'runtime.asyncQuestion.supports'
      ? { supported: true, threadId: address.threadId }
      : { threadId: address.threadId, questions: [current] })
    render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
    await userEvent.click(await screen.findByTestId('async-question-toggle'))
    current = { ...saved, revision: 2, answer: { ...saved.answer!,
      ...(change === 'submission' ? { submissionId: 'another-submission' } : {}),
      ...(change === 'payload' ? { answers: { item: { text: 'Foreign answer' } } } : {}),
      ...(change === 'timestamp' ? { acceptedAtMs: 9 } : {}),
    } }
    await userEvent.click(screen.getByTestId('async-question-refresh'))
    expect(screen.getByTestId('async-question-retry')).toBeEnabled()
    expect(screen.getByText('Confirmed answer')).toBeVisible()
    expect(screen.getByTestId('async-question-continue-delivery-question')).toBeDisabled()
    expect(screen.getByTestId('composer')).toBeEnabled()
    // A genuinely older snapshot can retain the same answer or predate it.
    current = { ...saved, revision: 2 }
    await userEvent.click(screen.getByTestId('async-question-retry'))
    await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
    current = question
    await userEvent.click(screen.getByTestId('async-question-refresh'))
    expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument()
    expect(screen.getByText('Confirmed answer')).toBeVisible()
    expect(screen.getByTestId('async-question-continue-delivery-question')).toBeEnabled()
    expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
  }
)
