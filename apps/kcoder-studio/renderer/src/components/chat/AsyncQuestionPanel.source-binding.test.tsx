import { render, screen, waitFor } from '@testing-library/react'
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
  questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false,
    options: [{ id: 'fast', label: 'Fast', description: '' }] }],
}
beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => {
  bridge.request.mockReset()
  bridge.subscribe.mockResolvedValue(vi.fn())
})

async function fixture() {
  let current: AsyncQuestionRecord = question
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    if (params.method !== 'asyncQuestion/list') throw new Error('Unexpected mutation')
    return { threadId: address.threadId, questions: [current] }
  })
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  return { replace: (value: AsyncQuestionRecord) => { current = value } }
}

for (const field of ['requestId', 'sourceTurnId', 'toolCallId', 'prompt', 'option label', 'selection mode'] as const) {
  it(`retains the original prompt and draft when a higher list revision changes ${field}`, async () => {
    const f = await fixture()
    const draft = screen.getByTestId('request-user-input-custom-item')
    await userEvent.type(draft, 'Answer for the original prompt')
    const changed = structuredClone(question)
    changed.revision = 9
    if (field === 'prompt') changed.questions[0].question = 'A different prompt?'
    else if (field === 'option label') changed.questions[0].options[0].label = 'Different meaning'
    else if (field === 'selection mode') changed.questions[0].multiSelect = true
    else changed[field] = 'foreign-source'
    f.replace(changed)
    await userEvent.click(screen.getByTestId('async-question-refresh'))
    expect(screen.getByTestId('async-question-retry')).toBeEnabled()
    expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
    expect(draft).toHaveValue('Answer for the original prompt')
    expect(screen.getByText('Which mode?')).toBeInTheDocument()
    expect(screen.queryByText('A different prompt?')).not.toBeInTheDocument()
    expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
    expect(screen.getByTestId('composer')).toBeEnabled()
    expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(0)
    f.replace(question)
    await userEvent.click(screen.getByTestId('async-question-retry'))
    await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
    expect(draft).toHaveValue('Answer for the original prompt')
  })
}
