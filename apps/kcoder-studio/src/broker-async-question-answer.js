import { createHash } from 'node:crypto';

// A Symbol cannot be supplied through client JSON. Tombstones retain only this
// fixed-size identity, never answer text; repeated compaction preserves it.
export const ASYNC_ANSWER_FINGERPRINT = Symbol('async question answer fingerprint');

export function asyncAnswerFingerprint(answers) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(answers)) return null;
  const entries = [];
  for (const id of Object.keys(answers).sort()) {
    const value = answers[id];
    if (!record(value) || Object.keys(value).some(key => !['selectedOptionIds', 'text'].includes(key))) return null;
    const options = value.selectedOptionIds === undefined ? [] : value.selectedOptionIds;
    if (!Array.isArray(options) || options.some(option => typeof option !== 'string') ||
        (value.text != null && typeof value.text !== 'string')) return null;
    // Match Rust's Vec default and Option semantics; preserve option order and
    // every text byte, while BTreeMap key insertion order has no meaning.
    entries.push([id, options, value.text ?? null]);
  }
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function normalizeAsyncQuestionForReplay(question) {
  // Compare Rust's Vec defaults, Option fields and unsigned timestamps
  // without changing the wire frame. JSON serializes either zero as 0.
  const { answer, deliveryError, ...record } = question;
  if (Object.is(record.createdAtMs, -0)) record.createdAtMs = 0;
  if (deliveryError != null) record.deliveryError = deliveryError;
  if (answer == null) return record;
  const answers = Object.fromEntries(Object.entries(answer.answers).map(([id, value]) =>
    [id, { selectedOptionIds: value.selectedOptionIds ?? [], text: value.text ?? null }]));
  const normalizedAnswer = { ...answer, answers };
  if (Object.is(normalizedAnswer.acceptedAtMs, -0)) normalizedAnswer.acceptedAtMs = 0;
  return { ...record, answer: normalizedAnswer };
}

export function asyncQuestionLocator({ threadId, questionId, requestId, sourceTurnId, toolCallId }) {
  return { threadId, questionId, requestId, sourceTurnId, toolCallId };
}

export function asyncQuestionReplayIdentity(message, asQuestionHint = false) {
  const { method, jsonrpc = '2.0' } = message;
  // Transport sequence and envelope extensions do not change the saved question.
  const { sequence: _sequence, question, ...params } = message.params;
  // Hints only trigger readback. Callers retain the highest revision per locator.
  params.question = asQuestionHint || question.questions === undefined
    ? asyncQuestionLocator(question)
    : normalizeAsyncQuestionForReplay(question);
  return { method, jsonrpc, params };
}
