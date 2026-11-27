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
  sourceTurnId: 'turn', toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Note', question: 'Any details?', multiSelect: false, options: [] }],
}

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset() })

it.each(['pending', 'cancelled', 'stale'] as const)(
  'an answer receipt with %s and no winning answer preserves the draft', async status => {
    let holdRead = false
    let finishRead: ((value: unknown) => void) | undefined
    bridge.request.mockImplementation(async (command, params) => {
      if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
      if (params.method === 'asyncQuestion/answer') {
        holdRead = true
        return { threadId: address.threadId, accepted: false, duplicate: false,
          question: { ...question, revision: status === 'pending' ? 1 : 2, status } }
      }
      if (holdRead) return new Promise(resolve => { finishRead = resolve })
      return { threadId: address.threadId, questions: [question] }
    })
    render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
    await userEvent.click(await screen.findByTestId('async-question-toggle'))
    const draft = screen.getByTestId('request-user-input-custom-item')
    await userEvent.type(draft, 'Keep my original draft')
    await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
    expect(await screen.findByTestId('async-question-submit-error')).toBeInTheDocument()
    expect(draft).toHaveValue('Keep my original draft')
    expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
    expect(screen.getByTestId('composer')).toBeEnabled()
    holdRead = false
    finishRead?.({ threadId: address.threadId, questions: [question] })
    await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
    expect(draft).toHaveValue('Keep my original draft')
    expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(1)
  },
)
