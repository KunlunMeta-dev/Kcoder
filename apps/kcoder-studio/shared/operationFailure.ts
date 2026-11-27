/** Admission facts only. These never authorize replay or replace execution receipts. */
export function operationFailure(error: unknown): {
  outcome: 'rejected' | 'unknown'
  reason: 'schedule_time_passed' | 'source_turn_running' | 'receipt_missing' | 'workflow_inputs_required' | 'creation_context_changed' | 'failed'
} {
  const value = error !== null && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown; recovery?: unknown; uncertain?: unknown }
    : {}
  const message = typeof error === 'string' ? error : value.message
  if (value.code === 'OFFICE_ACTION_NOT_FOUND' || value.code === 'OFFICE_RECONCILIATION_REQUIRED')
    return { outcome: 'unknown', reason: 'receipt_missing' }
  if (value.uncertain === true || value.recovery === 'reconcile_original')
    return { outcome: 'unknown', reason: 'failed' }
  // Exact legacy pre-admission errors; arbitrary remote errors may follow a committed write.
  if (message === 'scheduled time must be in the future')
    return { outcome: 'rejected', reason: 'schedule_time_passed' }
  if (message === 'cron creation context changed; prepare a new creation')
    return { outcome: 'rejected', reason: 'creation_context_changed' }
  if (message === 'temporary chat requires a completed source turn; wait for the current response to finish')
    return { outcome: 'rejected', reason: 'source_turn_running' }
  if (value.code === 'AUTOMATION_INVALID_INPUTS')
    return { outcome: 'rejected', reason: 'workflow_inputs_required' }
  const rejected = (value.uncertain === false && typeof value.code === 'string')
    || value.recovery === 'none' || value.recovery === 'repair_configuration'
    || value.recovery === 'explicit_user_decision'
  return { outcome: rejected ? 'rejected' : 'unknown', reason: 'failed' }
}
