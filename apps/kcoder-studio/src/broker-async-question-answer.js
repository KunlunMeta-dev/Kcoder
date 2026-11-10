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
