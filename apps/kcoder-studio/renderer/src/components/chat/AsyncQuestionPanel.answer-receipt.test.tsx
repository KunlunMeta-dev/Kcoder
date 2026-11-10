import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionAnswerResult, AsyncQuestionRecord } from '../../../../shared/generated/contracts'
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
  questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false, options: [] }],
}
beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset() })

async function answerWith(transform: (receipt: AsyncQuestionAnswerResult) => void, reconcileRejected = true) {
  let current = question
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    if (params.method === 'asyncQuestion/answer') {
      const receipt: AsyncQuestionAnswerResult = {
        threadId: address.threadId, accepted: true, duplicate: false,
        question: { ...question, revision: 2, status: 'context_applied', answer: {
          submissionId: params.params.submissionId,
          answers: structuredClone(params.params.answers), acceptedAtMs: 2,
        } },
      }
      transform(receipt)
      // A rejected receipt must reconcile without replaying this mutation.
      if (reconcileRejected && !receipt.accepted) current = receipt.question
      return receipt
    }
    return { threadId: address.threadId, questions: [current] }
  })
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  const draft = screen.getByTestId('request-user-input-custom-item')
  await userEvent.type(draft, 'My original answer')
  await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
  return draft
}

const mismatches: [string, (receipt: AsyncQuestionAnswerResult) => void][] = [
  ['request', receipt => { receipt.question.requestId = 'another-request' }],
  ['source turn', receipt => { receipt.question.sourceTurnId = 'another-turn' }],
  ['tool call', receipt => { receipt.question.toolCallId = 'another-tool' }],
  ['prompt', receipt => { receipt.question.questions = [{ ...question.questions[0], question: 'A different prompt?' }] }],
  ['selection mode', receipt => { receipt.question.questions = [{ ...question.questions[0], multiSelect: true }] }],
  ['submission', receipt => { receipt.question.answer!.submissionId = 'another-submission' }],
  ['text', receipt => { receipt.question.answer!.answers.item.text = 'Another answer' }],
  ['missing answer', receipt => { delete receipt.question.answer }],
  ['missing item', receipt => { receipt.question.answer!.answers = {} }],
  ['extra item', receipt => { receipt.question.answer!.answers.extra = { text: 'Another answer' } }],
  ['selection', receipt => { receipt.question.answer!.answers.item.selectedOptionIds = ['another-option'] }],
]
it.each(mismatches)('rejects an accepted receipt with mismatched %s without consuming the original draft', async (_name, transform) => {
  const draft = await answerWith(transform)
  expect(await screen.findByTestId('async-question-submit-error')).toBeInTheDocument()
  expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
  expect(draft).toHaveValue('My original answer')
  expect(screen.getByTestId('composer')).toBeEnabled()
  expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(1)
})

it('accepts Rust default selections in the original saved answer', async () => {
  await answerWith(receipt => { delete receipt.question.answer!.answers.item.selectedOptionIds })
  expect(screen.queryByTestId('async-question-submit-error')).not.toBeInTheDocument()
  expect(screen.queryByTestId('request-user-input-custom-item')).not.toBeInTheDocument()
  expect(screen.getByTestId('async-question-card-question')).toHaveTextContent('My original answer')
})

it('shows the authoritative winning answer when another device won', async () => {
  await answerWith(receipt => {
    receipt.accepted = false
    receipt.question.answer!.submissionId = 'winning-device'
    receipt.question.answer!.answers.item.text = 'The winning answer'
  })
  expect(screen.queryByTestId('async-question-submit-error')).not.toBeInTheDocument()
  expect(screen.queryByTestId('request-user-input-custom-item')).not.toBeInTheDocument()
  expect(screen.getByTestId('async-question-card-question')).toHaveTextContent('The winning answer')
})

it.each(['requestId', 'sourceTurnId', 'toolCallId'] as const)(
  'rejects a competing answer receipt with a different %s', async field => {
    const draft = await answerWith(receipt => {
      receipt.accepted = false
      receipt.question[field] = 'another-source'
      receipt.question.answer!.submissionId = 'winning-device'
      receipt.question.answer!.answers.item.text = 'An unrelated answer'
    }, false)
    expect(await screen.findByTestId('async-question-submit-error')).toBeInTheDocument()
    expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
    expect(draft).toHaveValue('My original answer')
    expect(screen.queryByText('An unrelated answer')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeEnabled()
    expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(1)
  }
)
