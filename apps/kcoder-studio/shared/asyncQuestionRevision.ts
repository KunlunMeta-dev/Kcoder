import type { AsyncQuestionRecord } from './generated/contracts'

function sourceFields(question: AsyncQuestionRecord) {
  return [
    question.questionId, question.requestId, question.threadId,
    question.sourceTurnId, question.toolCallId,
    question.questions.map(item => [item.id, item.header || item.id, item.question,
      item.multiSelect, item.options.map(option => [option.id, option.label, option.description ?? ''])]),
    question.createdAtMs,
  ]
}

// State binds prompt content to the original request digest. A higher delivery
// revision cannot change the question that a retained draft or answer belongs to.
export function asyncQuestionSourceFingerprint(question: AsyncQuestionRecord): string {
  return JSON.stringify(sourceFields(question))
}

// The revision tuple ends with revision, status, delivery error and answer.
export function asyncQuestionSourceFromRevision(fingerprint: string): string | undefined {
  try {
    const fields: unknown = JSON.parse(fingerprint)
    if (Array.isArray(fields) && fields.length === 11)
      return JSON.stringify(fields.slice(0, -4))
  } catch {
    // Only complete notification fingerprints can establish a revision floor.
  }
}

function answerFields(answer: AsyncQuestionRecord['answer']) {
  return answer ? [answer.submissionId, answer.acceptedAtMs,
    Object.keys(answer.answers).sort().map(id => [id,
      answer.answers[id].selectedOptionIds ?? [], answer.answers[id].text ?? null])] : null
}

export function isAsyncQuestionTerminal(status: AsyncQuestionRecord['status']): boolean {
  return status === 'cancelled' || status === 'stale' ||
    status === 'context_applied' || status === 'delivery_failed'
}

// State preserves saved answers and settled delivery outcomes. Unknown delivery
// may reconcile as applied, and task interruption may mark unfinished work stale.
export function asyncQuestionCommittedStateChanged(previous: AsyncQuestionRecord, next: AsyncQuestionRecord): boolean {
  // An older pre-answer snapshot is compatible, but two saved answers for the
  // same question must agree regardless of delivery revision or arrival order.
  if (previous.answer != null && next.answer != null &&
      JSON.stringify(answerFields(previous.answer)) !== JSON.stringify(answerFields(next.answer))) return true
  // An unanswered cancellation/staleness cannot precede or follow a saved
  // answer: State never accepts a first answer after either terminal state,
  // and withdrawal/staleness preserves any answer already saved.
  if ((previous.answer == null && next.answer != null &&
       (previous.status === 'cancelled' || previous.status === 'stale')) ||
      (next.answer == null && previous.answer != null &&
       (next.status === 'cancelled' || next.status === 'stale'))) return true
  // Arrival order does not change State's transition rules. Check the older
  // revision first even when its snapshot or receipt arrives last.
  if (next.revision < previous.revision) [previous, next] = [next, previous]
  // A queued answer cannot return to the legacy saved-only state.
  // Claiming it or repeating an unknown delivery also keeps its revision.
  if (previous.revision !== next.revision &&
      ((previous.status === 'queued' && (next.status === 'queued' || next.status === 'answer_saved')) ||
       (previous.status === 'delivery_unknown' && next.status === 'delivery_unknown'))) return true
  // State preserves terminal records even when the source turn is stopped.
  if (isAsyncQuestionTerminal(previous.status) &&
      (next.status !== previous.status || next.revision !== previous.revision)) return true
  // Only the original history receipt advances an unknown claim by one revision.
  if (previous.status === 'delivery_unknown' && next.status !== 'delivery_unknown' &&
      (next.status !== 'context_applied' || next.revision !== previous.revision + 1)) return true
  return previous.answer != null && next.answer == null
}

// Compare one revision's wire content with Rust's optional/default semantics.
// Object key order is immaterial; item/option order and answer text are exact.
export function asyncQuestionRevisionFingerprint(question: AsyncQuestionRecord): string {
  return JSON.stringify([
    ...sourceFields(question), question.revision, question.status, question.deliveryError ?? null,
    answerFields(question.answer),
  ])
}
