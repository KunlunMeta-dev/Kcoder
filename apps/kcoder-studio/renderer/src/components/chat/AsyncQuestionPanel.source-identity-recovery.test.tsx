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
  questions: [{ id: 'item', header: 'Details', question: 'Any details?', multiSelect: false, options: [] }],
}

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset(); bridge.subscribe.mockReset().mockResolvedValue(vi.fn()) })

for (const field of ['questionId', 'requestId', 'sourceTurnId', 'toolCallId'] as const) {
  it.each(['', ' \t\n '])(`a cold list with blank ${field} can recover its original source (%j)`, async value => {
    let current = { ...question, [field]: value }
    bridge.request.mockImplementation(async command => command === 'runtime.asyncQuestion.supports'
      ? { supported: true, threadId: address.threadId }
      : { threadId: address.threadId, questions: [current] })
    render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
    await act(async () => {})
  expect(screen.queryByTestId('async-question-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('request-user-input-submit-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeEnabled()
    current = question
    await act(async () => bridge.subscribe.mock.calls[0][0]({ event: 'async-question:refresh', payload: {
      taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
    } }))
    await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
    await userEvent.click(await screen.findByTestId('async-question-toggle'))
    expect(await screen.findByText('Any details?')).toBeVisible()
    await userEvent.type(screen.getByTestId('request-user-input-custom-item'), 'Retained original task answer')
    expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled()
    expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
  })
}
