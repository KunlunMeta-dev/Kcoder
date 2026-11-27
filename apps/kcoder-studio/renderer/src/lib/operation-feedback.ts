import i18n from '@/i18n'
import { operationFailure } from '../../../shared/operationFailure'

/** Keep admission classification and user-facing failure copy out of individual pages. */
export function operationFeedback(error: unknown, operation: 'read' | 'write' = 'write') {
  const failure = operationFailure(error)
  const reason = operation === 'write' && failure.reason === 'failed' && failure.outcome === 'unknown'
    ? 'unconfirmed' : failure.reason
  const key = reason === 'workflow_inputs_required'
    ? 'automations.workflowDefaultsRequired' : `operation_errors.${reason}`
  return {
    ...failure,
    message: i18n.t(key, { ns: 'common' }),
  }
}
