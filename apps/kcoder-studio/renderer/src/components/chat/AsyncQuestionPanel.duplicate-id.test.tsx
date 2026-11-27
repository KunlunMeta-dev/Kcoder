import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  sourceTurnId: 'turn', toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false, options: [] }],
}
beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset(); bridge.subscribe.mockReset().mockResolvedValue(vi.fn()) })

function fixture(initial: AsyncQuestionRecord[]) {
  let questions = initial
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    if (params.method === 'asyncQuestion/answer') return {
      threadId: address.threadId, accepted: true, duplicate: false,
      question: { ...question, revision: 3, status: 'context_applied',
        answer: { submissionId: params.params.submissionId, answers: params.params.answers, acceptedAtMs: 2 } },
    }
    return { threadId: address.threadId, questions }
  })
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  return (next: AsyncQuestionRecord[]) => { questions = next }
}

const duplicates = {
  'identical question ID': structuredClone(question),
  'conflicting question ID': {
    ...question, requestId: 'another-request', sourceTurnId: 'another-turn', toolCallId: 'another-tool',
    questions: [{ ...question.questions[0], question: 'A different prompt with the same ID?' }],
  },
  'same source turn and tool call under a different question ID': {
    ...question, questionId: 'another-question', requestId: 'another-request',
  },
}

for (const [label, duplicate] of Object.entries(duplicates)) {
  it(`rejects an initial ${label} collision without exposing answer cards`, async () => {
    const replace = fixture([question, duplicate])
    await act(async () => {})
    expect(screen.queryByTestId('async-question-panel')).not.toBeInTheDocument()
    expect(screen.queryAllByTestId('async-question-card-question')).toHaveLength(0)
    await userEvent.type(screen.getByTestId('composer'), 'The conversation still works')
    replace([question])
    await act(async () => bridge.subscribe.mock.calls[0][0]({ event: 'async-question:refresh', payload: {
      taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
    } }))
    expect(await screen.findAllByTestId('async-question-card-question')).toHaveLength(1)
    expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
  })

  it(`rejects a ${label} collision refresh and preserves the original draft`, async () => {
    const replace = fixture([question])
    await userEvent.click(await screen.findByTestId('async-question-toggle'))
    const card = screen.getByTestId('async-question-card-question')
    const draft = screen.getByTestId('request-user-input-custom-item')
    await userEvent.type(draft, 'My original answer')
    replace([question, duplicate])
    await userEvent.click(screen.getByTestId('async-question-refresh'))
    expect(screen.getByTestId('async-question-retry')).toBeEnabled()
    expect(screen.getAllByTestId('async-question-card-question')).toEqual([card])
    expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
    expect(draft).toHaveValue('My original answer')
    const action = screen.getByTestId('request-user-input-submit-button')
    expect(action).toBeDisabled()
    fireEvent.click(action)
    expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
    expect(screen.getByTestId('composer')).toBeEnabled()
    replace([question])
    await userEvent.click(screen.getByTestId('async-question-retry'))
    await waitFor(() => expect(action).toBeEnabled())
    expect(draft).toHaveValue('My original answer')
    await userEvent.click(action)
    const answers = bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')
    expect(answers).toHaveLength(1)
    expect(answers[0][1].params).toMatchObject({ threadId: address.threadId,
      questionId: question.questionId, expectedRevision: 1, answers: { item: { text: 'My original answer' } } })
  })
}

it('allows a tool call ID to recur in a different source turn', async () => {
  fixture([question, {
    ...question, questionId: 'another-question', requestId: 'another-request', sourceTurnId: 'another-turn',
  }])
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  expect(await screen.findByTestId('async-question-card-another-question')).toBeVisible()
  expect(screen.getByTestId('async-question-card-question')).toBeVisible()
})
