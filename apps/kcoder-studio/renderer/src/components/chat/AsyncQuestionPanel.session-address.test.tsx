import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const expected = { targetId: 'original-native', workspaceId: 'original-workspace', threadId: 'thread' }
const question: AsyncQuestionRecord = {
  questionId: 'question', requestId: 'request', threadId: 'thread', sourceTurnId: 'source',
  toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }],
}

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => {
  bridge.request.mockReset()
  bridge.subscribe.mockReset().mockResolvedValue(() => undefined)
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: 'thread' }
    if (params.method === 'asyncQuestion/answer') return {
      threadId: 'thread', accepted: true, duplicate: false,
      question: { ...question, status: 'queued', revision: 2, answer: {
        submissionId: params.params.submissionId, answers: params.params.answers, acceptedAtMs: 2,
      } },
    }
    return { threadId: 'thread', questions: [question] }
  })
})

const address = () => ({ taskId: 'kcoder:target:thread', deviceId: 'target', threadId: 'thread',
  workspacePath: '/original', expectedSessionAddress: { ...expected } })

it('support, refresh, reconnect and answer retain the rendered canonical session selector', async () => {
  const original = address()
  render(<AsyncQuestionPanel address={original} />)
  fireEvent.click(await screen.findByTestId('async-question-toggle'))
  fireEvent.change(screen.getByTestId('request-user-input-custom-item'), { target: { value: 'original draft' } })
  fireEvent.click(screen.getByTestId('async-question-refresh'))
  await waitFor(() => expect(bridge.request.mock.calls.filter(([, params]) =>
    params.method === 'asyncQuestion/list')).toHaveLength(2))
  await act(async () => bridge.subscribe.mock.calls[0][0]({ event: 'async-question:refresh', payload: {
    taskId: original.taskId, serverId: original.deviceId, threadId: 'thread', workspacePath: '/original',
  } }))
  await waitFor(() => expect(bridge.request.mock.calls.filter(([command]) =>
    command === 'runtime.asyncQuestion.supports')).toHaveLength(2))
  await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() => expect(bridge.request.mock.calls.some(([, params]) =>
    params.method === 'asyncQuestion/answer')).toBe(true))
  // A reused caller DTO cannot rewrite the selector captured by dispatched requests.
  original.expectedSessionAddress.workspaceId = 'replacement-workspace'
  expect(bridge.request.mock.calls.every(([, params]) =>
    JSON.stringify(params.expectedSessionAddress) === JSON.stringify(expected))).toBe(true)
})

it('a different canonical session under the same task ID cannot retain the old draft or input authority', async () => {
  const original = address()
  const view = render(<><AsyncQuestionPanel address={original} /><input data-testid="composer" /></>)
  fireEvent.click(await screen.findByTestId('async-question-toggle'))
  fireEvent.change(screen.getByTestId('request-user-input-custom-item'), { target: { value: 'old session draft' } })
  const before = bridge.request.mock.calls.length
  const replacement = { ...original, expectedSessionAddress: { ...expected, workspaceId: 'replacement-workspace' } }
  bridge.request.mockImplementation(async () => { throw new Error('SESSION_ADDRESS_EXPECTATION_CONFLICT') })
  view.rerender(<><AsyncQuestionPanel address={replacement} /><input data-testid="composer" /></>)
  await waitFor(() => expect(bridge.request.mock.calls.length).toBeGreaterThan(before))
  expect(screen.queryByDisplayValue('old session draft')).not.toBeInTheDocument()
  expect(bridge.request.mock.calls.slice(before).every(([command, params]) =>
    command === 'runtime.asyncQuestion.supports' &&
    params.expectedSessionAddress.workspaceId === 'replacement-workspace')).toBe(true)
  expect(screen.getByTestId('composer')).toBeEnabled()
})
