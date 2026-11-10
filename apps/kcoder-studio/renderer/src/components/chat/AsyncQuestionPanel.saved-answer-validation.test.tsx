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
  questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false,
    options: [{ id: 'fast', label: 'Fast', description: '' },
      { id: 'careful', label: 'Careful', description: '' }] }],
}
type Answers = NonNullable<AsyncQuestionRecord['answer']>['answers']
const saved = (answers: Answers): AsyncQuestionRecord => ({
  ...question, revision: 2, status: 'queued',
  answer: { submissionId: 'winning-device', acceptedAtMs: 2, answers },
})

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset() })

async function fixture(original = question) {
  let current = original
  let receipt = { ...saved({ item: { text: 'Valid winner' } }), questions: original.questions }
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    if (params.method === 'asyncQuestion/answer') return {
      threadId: address.threadId, accepted: false, duplicate: false, question: receipt,
    }
    return { threadId: address.threadId, questions: [current] }
  })
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  return { replace: (record: AsyncQuestionRecord) => { current = record },
    receipt: (record: AsyncQuestionRecord) => { receipt = record } }
}

const invalid: [string, Answers][] = [
  ['missing item', {}],
  ['foreign item', { other: { text: 'Foreign answer' } }],
  ['extra item', { item: { text: 'Answer' }, other: { text: 'Foreign answer' } }],
  ['foreign option', { item: { selectedOptionIds: ['other-option'] } }],
  ['multiple single-choice selections', { item: { selectedOptionIds: ['fast', 'careful'] } }],
  ['duplicate selection', { item: { selectedOptionIds: ['fast', 'fast'] } }],
  ['blank answer', { item: { text: ' \t\n ' } }],
]

it.each(['answer_saved', 'queued', 'context_applied', 'delivery_unknown', 'delivery_failed'] as const)(
  '%s without a saved answer preserves the original prompt and draft', async status => {
    const f = await fixture()
    const draft = screen.getByTestId('request-user-input-custom-item')
    await userEvent.type(draft, 'Keep my original draft')
    f.replace({ ...question, revision: 2, status, answer: null })
    await userEvent.click(screen.getByTestId('async-question-refresh'))
    expect(screen.getByTestId('async-question-retry')).toBeEnabled()
    expect(draft).toHaveValue('Keep my original draft')
    expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
    expect(screen.getByTestId('composer')).toBeEnabled()
    f.replace(question)
    await userEvent.click(screen.getByTestId('async-question-retry'))
    await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
    expect(draft).toHaveValue('Keep my original draft')
    expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
  },
)

it('a competing receipt without its saved answer preserves the draft and reads the original task', async () => {
  const f = await fixture()
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'Keep my original draft')
  f.receipt({ ...question, revision: 2, status: 'queued' })
  await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(await screen.findByTestId('async-question-submit-error')).toBeInTheDocument()
  expect(draft).toHaveValue('Keep my original draft')
  expect(screen.getByTestId('composer')).toBeEnabled()
  expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(1)
})

it('a pending list record with a saved answer preserves the draft and closes input until readback', async () => {
  const f = await fixture()
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'Keep my original draft')
  f.replace({ ...saved({ item: { text: 'Winner' } }), status: 'pending' })
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(screen.getByTestId('async-question-retry')).toBeEnabled()
  expect(draft).toHaveValue('Keep my original draft')
  expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
  expect(screen.getByTestId('composer')).toBeEnabled()
  f.replace(question)
  await userEvent.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
  expect(draft).toHaveValue('Keep my original draft')
  expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
})

it('a competing pending receipt with a saved answer cannot consume the draft', async () => {
  const f = await fixture()
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'Keep my original draft')
  f.receipt({ ...saved({ item: { text: 'Winner' } }), status: 'pending' })
  await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(await screen.findByTestId('async-question-submit-error')).toBeInTheDocument()
  expect(draft).toHaveValue('Keep my original draft')
  expect(screen.getByTestId('composer')).toBeEnabled()
  expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(1)
})

it.each(invalid)('a saved %s cannot consume the draft during list refresh', async (_name, answers) => {
  const f = await fixture()
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'Keep my original draft')
  f.replace(saved(answers))
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(screen.getByTestId('async-question-retry')).toBeEnabled()
  expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
  expect(draft).toHaveValue('Keep my original draft')
  expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
  expect(screen.getByTestId('composer')).toBeEnabled()
  expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
  f.replace(question)
  await userEvent.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
  expect(draft).toHaveValue('Keep my original draft')
})

it.each(invalid)('a competing receipt with %s cannot settle the original card', async (_name, answers) => {
  const f = await fixture()
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'Keep my original draft')
  f.receipt(saved(answers))
  await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(await screen.findByTestId('async-question-submit-error')).toBeInTheDocument()
  expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
  expect(draft).toHaveValue('Keep my original draft')
  expect(screen.getByTestId('composer')).toBeEnabled()
  expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(1)
})

it.each([
  ['default selections', saved({ item: { text: ' exact winner ' } })],
  ['selected option', saved({ item: { selectedOptionIds: ['fast'], text: null } })],
  ['multiple-choice selections', { ...saved({ item: { selectedOptionIds: ['fast', 'careful'] } }),
    questions: [{ ...question.questions[0], multiSelect: true }] }],
] as const)('a valid saved answer preserves %s and the original delivery payload', async (_name, record) => {
  const f = await fixture({ ...question, questions: record.questions })
  f.replace(record)
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument()
  await userEvent.click(screen.getByTestId('async-question-continue-delivery-question'))
  const calls = bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')
  expect(calls).toHaveLength(1)
  expect(calls[0][1].params).toMatchObject({ submissionId: record.answer!.submissionId,
    expectedRevision: record.revision, answers: record.answer!.answers })
})
