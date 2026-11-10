// Compatibility locators supplement one task/turn identity. Reject ambiguity
// before clients close original input, reserve replay IDs or buffer recovery.
export function hasConflictingTurnIdentity(message: { method?: string; params?: unknown }): boolean {
  if (message.method !== 'turn/started' && message.method !== 'turn/completed') return false
  const params = (message.params ?? {}) as Record<string, unknown>
  const turn = params.turn as Record<string, unknown> | undefined
  const thread = params.thread as Record<string, unknown> | undefined
  const widget = params.widget as Record<string, unknown> | undefined
  return [
    [params.threadId, params.thread_id, thread?.threadId, thread?.id,
      widget?.threadId, turn?.threadId],
    [params.turnId, params.turn_id, turn?.turnId, turn?.id],
  ].some(values => values.some(value => value != null &&
    (typeof value !== 'string' || !value.trim())) ||
    new Set(values.filter(value => typeof value === 'string')).size > 1)
}
