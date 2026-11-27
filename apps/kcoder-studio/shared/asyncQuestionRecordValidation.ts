import type { AsyncQuestionRecord } from './generated/contracts'

// Measure UTF-8 without importing the optional device transport.
export function asyncQuestionUtf8Length(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

// Rust str::trim includes U+0085 but preserves U+FEFF as content.
export function hasAsyncQuestionText(value: string): boolean {
  return /\P{White_Space}/u.test(value)
}

export function hasValidAsyncQuestionRevision(
  { status, revision, answer, deliveryError }: {
    status?: AsyncQuestionRecord['status']
    revision: number
    answer?: unknown
    deliveryError?: unknown
  },
): boolean {
  if (status === 'pending') return revision === 1 && answer == null
  // Saving the answer advances to revision two. Claiming it does not advance it.
  if (status === 'queued') return revision === 2
  // A delivery outcome or retirement of a saved answer requires another transition.
  const retired = status === 'cancelled' || status === 'stale'
  const deliverySettled = status === 'context_applied' || status === 'delivery_failed' ||
    status === 'delivery_unknown' || deliveryError != null
  const minimumRevision = deliverySettled || (retired && answer != null) ? 3
    : status !== undefined || answer != null ? 2 : 1
  return revision >= minimumRevision
}

// Complete snapshots carry the original diagnostic exactly when delivery is
// failed or unknown. Sparse notification hints are validated separately.
export function hasValidAsyncQuestionDeliveryError(
  { status, deliveryError }: Pick<AsyncQuestionRecord, 'status' | 'deliveryError'>,
): boolean {
  const needsError = status === 'delivery_failed' || status === 'delivery_unknown'
  return (deliveryError != null) === needsError
}

// Structural wire guards cannot bind saved answers to the original items and
// options. Check that binding before a list or competing receipt consumes drafts.
export function hasValidQuestionAnswers(question: AsyncQuestionRecord): boolean {
  // A complete snapshot must retain usable original request/source identities.
  // Reject it before a card or notification replay binds to an invalid source.
  if ([question.questionId, question.requestId, question.sourceTurnId, question.toolCallId]
    .some(id => !hasAsyncQuestionText(id))) return false
  if (!hasValidAsyncQuestionRevision(question)) return false
  const retired = question.status === 'cancelled' || question.status === 'stale'
  if (question.questions.length < 1 || question.questions.length > 8) return false
  if (new Set(question.questions.map(item => item.id)).size !== question.questions.length ||
      question.questions.some(item => !hasAsyncQuestionText(item.id) || !hasAsyncQuestionText(item.header) || !hasAsyncQuestionText(item.question) ||
        item.options.length > 16 ||
        item.options.some(option => !hasAsyncQuestionText(option.id) || !hasAsyncQuestionText(option.label)) ||
        new Set(item.options.map(option => option.id)).size !== item.options.length))
    return false
  // A saved winner must retain the identity used to reconcile or continue it.
  if (question.answer && !hasAsyncQuestionText(question.answer.submissionId)) return false
  if (!hasValidQuestionByteBudgets(question)) return false
  if (!hasValidAsyncQuestionDeliveryError(question)) return false
  const answers = question.answer?.answers
  // Delivery states require the saved answer; a status alone must not consume
  // an unanswered card or its draft. Withdrawal may precede any answer.
  if (!answers) return question.status === 'pending' || retired
  if (Object.keys(answers).length !== question.questions.length) return false
  return question.questions.every(item => {
    if (!Object.hasOwn(answers, item.id)) return false
    const answer = answers[item.id]
    const selected = answer.selectedOptionIds ?? []
    const optionIds = new Set(item.options.map(option => option.id))
    return (item.multiSelect || selected.length <= 1) &&
      new Set(selected).size === selected.length &&
      selected.every(id => optionIds.has(id)) &&
      (selected.length > 0 || hasAsyncQuestionText(answer.text ?? ''))
  })
}

// Generated wire guards check structure, but State also bounds UTF-8 fields
// and serde-serialized drafts/answers. Apply those limits before retaining a
// source or spending a notification sequence, including on older Gateways.
export function hasValidQuestionByteBudgets(question: AsyncQuestionRecord): boolean {
  if ([question.questionId, question.requestId, question.sourceTurnId, question.toolCallId,
    ...(question.answer ? [question.answer.submissionId] : [])].some(id => asyncQuestionUtf8Length(id) > 256) ||
      question.questions.some(item => asyncQuestionUtf8Length(item.id) > 256 || asyncQuestionUtf8Length(item.header) > 256 ||
        asyncQuestionUtf8Length(item.question) > 16 * 1024 || item.options.some(option =>
          asyncQuestionUtf8Length(option.id) > 256 || asyncQuestionUtf8Length(option.label) > 256 ||
          asyncQuestionUtf8Length(option.description) > 2 * 1024))) return false
  const draft = {
    sourceTurnId: question.sourceTurnId, toolCallId: question.toolCallId,
    questions: question.questions.map(item => ({ header: item.header, question: item.question,
      options: item.options.map(option => ({ label: option.label, description: option.description })),
      multiSelect: item.multiSelect })),
  }
  if (asyncQuestionUtf8Length(JSON.stringify(draft)) > 64 * 1024) return false
  if (question.deliveryError != null && asyncQuestionUtf8Length(JSON.stringify(question.deliveryError)) > 2 * 1024)
    return false
  if (question.answer) {
    // Rust fills the default Vec and omits None text before measuring its map.
    const answers = Object.fromEntries(Object.entries(question.answer.answers).map(([id, answer]) =>
      [id, { selectedOptionIds: answer.selectedOptionIds ?? [],
        ...(answer.text == null ? {} : { text: answer.text }) }]))
    if (asyncQuestionUtf8Length(JSON.stringify(answers)) > 16 * 1024) return false
  }
  return true
}
