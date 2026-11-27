// These task events are notifications even if a malformed frame carries
// the numeric ID of an unrelated, in-flight client request.
const TASK_NOTIFICATION_METHODS = new Set([
  'asyncQuestion/changed', 'question/resolved', 'approval/resolved', 'gateway/interaction/replyRejected',
  'turn/started', 'turn/completed', 'turn/failed', 'turn/interrupted',
])

export function hasInvalidTaskNotificationEnvelope(message: {
  method?: string
  id?: unknown
  jsonrpc?: unknown
}): boolean {
  return message.method !== undefined && TASK_NOTIFICATION_METHODS.has(message.method) &&
    (message.id !== undefined || Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error') ||
      (message.jsonrpc !== undefined && message.jsonrpc !== '2.0'))
}

// Compatibility locators supplement one task/turn identity. Reject ambiguity
// before clients close original input, reserve replay IDs or buffer recovery.
export function hasConflictingTurnIdentity(message: { method?: string; params?: unknown }): boolean {
  // Requests must pass the same binding fence before reserving a card or
  // recovery capacity; a later valid replay cannot replace the first prompt.
  if (!['turn/started', 'turn/completed', 'question/resolved', 'approval/resolved',
    'question/request', 'approval/request'].includes(message.method ?? '')) return false
  // Match Gateway admission before malformed lifecycle params reserve recovery
  // capacity or reach task/question observers through older transports.
  if (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)) return true
  const params = message.params as Record<string, unknown>
  // Older/direct transports can bypass Gateway validation. Invalid ordering
  // must not replace an attempt, retire its question or consume recovery slots.
  if (params.sequence !== undefined &&
      (!Number.isSafeInteger(params.sequence) || Number(params.sequence) < 0)) return true
  // Older transports may bypass Gateway admission. Malformed snapshots
  // cannot retire original input or spend a valid terminal's replay identity.
  if ([params.turn, params.thread, params.widget].some(value => value != null &&
      (typeof value !== 'object' || Array.isArray(value)))) return true
  const turn = params.turn as Record<string, unknown> | undefined
  const thread = params.thread as Record<string, unknown> | undefined
  const widget = params.widget as Record<string, unknown> | undefined
  // Legacy transports may bypass Gateway checks. Explicit lifecycle states must
  // agree before replacing attempts, retiring input or reserving replay capacity.
  const status = turn?.status
  if ((message.method === 'turn/started' || message.method === 'turn/completed') &&
      status !== undefined && (message.method === 'turn/started'
    ? status !== 'running'
    : typeof status !== 'string' || !['completed', 'failed', 'interrupted'].includes(status))) return true
  return [
    [params.threadId, params.thread_id, thread?.threadId, thread?.id,
      widget?.threadId, turn?.threadId],
    [params.turnId, params.turn_id, turn?.turnId, turn?.id],
    // Retry attempts share a turn ID. Consumers must not select different
    // executions from the outer and nested protocol locators.
    [params.attemptId, turn?.attemptId],
  ].some(values => values.some(value => value != null &&
    // Rust identities cannot contain isolated UTF-16 surrogates. Fence them
    // before they supersede an attempt or consume recovery capacity.
    // Match Rust whitespace: U+0085 is blank, while U+FEFF remains identity content.
    (typeof value !== 'string' || !/\P{White_Space}/u.test(value) || /\p{Surrogate}/u.test(value))) ||
    new Set(values.filter(value => typeof value === 'string')).size > 1)
}
