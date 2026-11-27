import { expect, test } from 'vitest'
import { hasValidQuestionAnswers } from '../../../../../shared/asyncQuestionRecordValidation'
import type { AsyncQuestionRecord } from '../../../../../shared/generated/contracts'

const question: AsyncQuestionRecord = {
  questionId: 'question', requestId: 'request', threadId: 'thread', sourceTurnId: 'source',
  toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Mode', question: 'Continue?', multiSelect: false,
    options: [{ id: 'yes', label: 'Yes', description: '' }] }],
}

test.each(['header', 'question', 'label', 'answer'])('desktop rejects Rust whitespace-only %s while preserving original content', field => {
  for (const [text, valid] of [[' \u0085\t', false], ['\ufeff', true], [' \u0085Original\u0085 ', true]] as const) {
    const record = structuredClone(question)
    if (field === 'answer') {
      record.status = 'queued'
      record.revision = 2
      record.answer = { submissionId: 'submission', acceptedAtMs: 2, answers: { item: { selectedOptionIds: [], text } } }
    } else if (field === 'label') record.questions[0].options[0].label = text
    else if (field === 'header') record.questions[0].header = text
    else record.questions[0].question = text
    const original = structuredClone(record)
    expect.soft(hasValidQuestionAnswers(record), JSON.stringify({ field, text })).toBe(valid)
    expect(record).toEqual(original)
  }
})
