import { expect, it } from 'vitest'
import type { AsyncQuestionRecord } from '../../../../../shared/generated/contracts'
import { hasValidQuestionAnswers } from '../../../../../shared/asyncQuestionRecordValidation'

const question: AsyncQuestionRecord = {
  questionId: 'question', requestId: 'request', threadId: 'thread', sourceTurnId: 'source',
  toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Mode', question: 'Continue?', options: [], multiSelect: false }],
}

it('preserves exact UTF-8 field boundaries without trimming or truncating source data', () => {
  const record = { ...question, sourceTurnId: '界'.repeat(85) + 'x', questions: [{
    ...question.questions[0], header: '界'.repeat(85) + 'x', question: '界'.repeat(5461) + 'x',
    options: [{ id: '😀'.repeat(64), label: '界'.repeat(85) + 'x', description: '界'.repeat(682) + 'xy' }],
  }] }
  expect(hasValidQuestionAnswers(record)).toBe(true)
  record.questions[0].options[0].id += 'x'
  expect(hasValidQuestionAnswers(record)).toBe(false)
})

it('measures saved answers with Rust defaults and counts JSON escaping', () => {
  const record: AsyncQuestionRecord = { ...question, revision: 2, status: 'queued', answer: {
    submissionId: 'winner', acceptedAtMs: 1, answers: { item: { text: 'x' } },
  } }
  const overhead = JSON.stringify({ item: { selectedOptionIds: [], text: '' } }).length
  record.answer!.answers.item.text = 'x'.repeat(16 * 1024 - overhead)
  expect(hasValidQuestionAnswers(record)).toBe(true)
  record.answer!.answers.item.text += 'x'
  expect(hasValidQuestionAnswers(record)).toBe(false)
  record.answer!.answers.item.text = '\u0001'.repeat(3000)
  expect(hasValidQuestionAnswers(record)).toBe(false)
})

it('bounds the original serialized draft while excluding generated item identities', () => {
  const record = { ...question, questions: Array.from({ length: 4 }, (_, index) => ({
    ...question.questions[0], id: `item-${index}`, question: 'x'.repeat(16 * 1024),
  })) }
  const draft = () => ({ sourceTurnId: record.sourceTurnId, toolCallId: record.toolCallId,
    questions: record.questions.map(item => ({ header: item.header, question: item.question,
      options: item.options, multiSelect: item.multiSelect })) })
  record.questions[3].question = record.questions[3].question.slice(JSON.stringify(draft()).length - 64 * 1024)
  expect(JSON.stringify(draft())).toHaveLength(64 * 1024)
  expect(hasValidQuestionAnswers(record)).toBe(true)
  record.questions[3].question += 'x'
  expect(hasValidQuestionAnswers(record)).toBe(false)
})
