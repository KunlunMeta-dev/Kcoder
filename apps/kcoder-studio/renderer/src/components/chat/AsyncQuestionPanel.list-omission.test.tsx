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
const peer = { ...question, questionId: 'peer-question', requestId: 'peer-request', toolCallId: 'peer-tool' }

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset() })

it.each(['empty', 'partial'] as const)('%s full-list refresh cannot erase an original card or its draft', async shape => {
  let questions = [question, peer]
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    expect(params.method).toBe('asyncQuestion/list')
    expect(params.params.includeTerminal).toBe(true)
    return { threadId: address.threadId, questions }
  })
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  const card = screen.getByTestId('async-question-card-question')
  const draft = card.querySelector('textarea')!
  await userEvent.type(draft, 'Keep the original answer draft')
  questions = shape === 'empty' ? [] : [peer]
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(screen.getByTestId('async-question-card-question')).toBe(card)
  expect(draft).toHaveValue('Keep the original answer draft')
  expect(screen.getByTestId('async-question-retry')).toBeEnabled()
  expect(card.querySelector('[data-testid="request-user-input-submit-button"]')).toBeDisabled()
  await userEvent.type(screen.getByTestId('composer'), 'Continue the ordinary task')
  questions = [question, peer]
  await userEvent.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
  expect(screen.getByTestId('async-question-card-question')).toBe(card)
  expect(draft).toHaveValue('Keep the original answer draft')
  expect(card.querySelector('[data-testid="request-user-input-submit-button"]')).toBeEnabled()
  expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
})

it('an initially empty task can later discover its first question', async () => {
  let questions: AsyncQuestionRecord[] = []
  bridge.request.mockImplementation(async command => command === 'runtime.asyncQuestion.supports'
    ? { supported: true, threadId: address.threadId } : { threadId: address.threadId, questions })
  const view = render(<AsyncQuestionPanel address={address} />)
  await waitFor(() => expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/list')).toBe(true))
  expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument()
  questions = [question]
  view.unmount()
  render(<AsyncQuestionPanel address={address} />)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  expect(screen.getByTestId('async-question-card-question')).toBeInTheDocument()
})
