const atom = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const copy = value => JSON.parse(JSON.stringify(value));
const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));

/** Native keeps accepted request receipts and only increases the original group's policy revision. */
export function expiredBudgetObservation(intent, query, view) {
  if (!intent || !query || query.jobId !== intent.jobId || query.requestId !== intent.requestId
    || view?.phase !== 'active' || view.jobId !== intent.jobId || view.requestedReceipt != null
    || !Number.isSafeInteger(intent.expectedPolicyRevision) || intent.expectedPolicyRevision < 0
    || !Number.isSafeInteger(view.policyRevision) || view.policyRevision <= intent.expectedPolicyRevision) return null;
  return copy({ query, view });
}

/** Loading selectors never repairs storage or creates a new request. */
export function normalizeBudgetCache(value, { jobId, validIntent, validView }) {
  if (!only(value, ['version', 'pending', 'history']) || !Array.isArray(value.history) || value.history.length > 10
    || value.pending !== null && (!validIntent(value.pending) || value.pending.jobId !== jobId)) return null;
  const pending = value.pending === null ? null : copy(value.pending);
  if (value.version === 1) {
    if (!value.history.every(atom) || new Set(value.history).size !== value.history.length) return null;
    return { version: 2, pending, history: value.history.map(requestId => ({ kind: 'acknowledged', requestId })) };
  }
  if (value.version !== 2) return null;
  const seen = new Set(), history = [];
  for (const row of value.history) {
    if (!row || !atom(row.requestId) || seen.has(row.requestId)) return null;
    seen.add(row.requestId);
    if (row.kind === 'acknowledged' && only(row, ['kind', 'requestId'])) history.push(copy(row));
    else if (row.kind === 'expired' && only(row, ['kind', 'requestId', 'intent', 'observation'])
      && validIntent(row.intent) && row.intent.jobId === jobId && row.requestId === row.intent.requestId
      && only(row.observation, ['query', 'view'])
      && only(row.observation.query, ['jobId', 'requestId'])
      && validView(row.observation.query, row.observation.view)
      && expiredBudgetObservation(row.intent, row.observation.query, row.observation.view)) history.push(copy(row));
    else return null;
  }
  return { version: 2, pending, history };
}

export function expiredBudgetHistoryRow(intent, query, view, validView) {
  if (!validView(query, view)) return null;
  const observation = expiredBudgetObservation(intent, query, view);
  return observation ? { kind: 'expired', requestId: intent.requestId, intent: copy(intent), observation } : null;
}
