import type { AsyncQuestionRecord } from './generated/contracts'

function sourceFields(question: AsyncQuestionRecord) {
  return [
    question.questionId, question.requestId, question.threadId,
    question.sourceTurnId, question.toolCallId,
    question.questions.map(item => [item.id, item.header || item.id, item.question,
      item.multiSelect, item.options.map(option => [option.id, option.label, option.description ?? ''])]),
  ]
}

// State binds prompt content to the original request digest. A higher delivery
// revision cannot change the question that a retained draft or answer belongs to.
export function asyncQuestionSourceFingerprint(question: AsyncQuestionRecord): string {
  return JSON.stringify(sourceFields(question))
}

function answerFields(answer: AsyncQuestionRecord['answer']) {
  return answer ? [answer.submissionId, answer.acceptedAtMs,
    Object.keys(answer.answers).sort().map(id => [id,
      answer.answers[id].selectedOptionIds ?? [], answer.answers[id].text ?? null])] : null
}

// State preserves saved answers and settled delivery outcomes. Unknown delivery
// may reconcile as applied, and task interruption may mark unfinished work stale.
export function asyncQuestionCommittedStateChanged(previous: AsyncQuestionRecord, next: AsyncQuestionRecord): boolean {
  // An older pre-answer snapshot is compatible, but two saved answers for the
  // same question must agree regardless of delivery revision or arrival order.
  if (previous.answer != null && next.answer != null &&
      JSON.stringify(answerFields(previous.answer)) !== JSON.stringify(answerFields(next.answer))) return true
  if (next.revision < previous.revision) return false
  if ((previous.status === 'cancelled' || previous.status === 'stale' || previous.status === 'context_applied') &&
      next.status !== previous.status) return true
  if (previous.status === 'delivery_failed' &&
      next.status !== 'delivery_failed' && next.status !== 'stale') return true
  if (previous.status === 'delivery_unknown' &&
      next.status !== 'delivery_unknown' && next.status !== 'context_applied' && next.status !== 'stale') return true
  return previous.answer != null && next.answer == null
}

// Compare one revision's wire content with Rust's optional/default semantics.
// Object key order is immaterial; item/option order and answer text are exact.
export function asyncQuestionRevisionFingerprint(question: AsyncQuestionRecord): string {
  return JSON.stringify([
    ...sourceFields(question), question.createdAtMs, question.revision, question.status, question.deliveryError ?? null,
    answerFields(question.answer),
  ])
}
