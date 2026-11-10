import type { MigrationHistoryJobResult } from '../../../shared/generated/contracts'

export function canReconcileLegacyHistory(value: MigrationHistoryJobResult) {
  return value.workerState === 'unknown' && !value.workerRunning && value.workerError === 'history_job_execution_untracked' && (value.job.cancelRequested || ['normalized', 'failed', 'cancelled'].includes(value.job.stage))
}

/** Negotiated fields may be absent after an interrupted upgrade; absence never proves idle. */
export function normalizeHistoryExecution(value: MigrationHistoryJobResult, negotiated: boolean): MigrationHistoryJobResult {
  if (!negotiated) return value
  if (value.workerState == null) return { ...value, workerState: 'unknown', workerError: 'history_job_execution_unknown' }
  if ((value.workerState === 'running') !== value.workerRunning) throw new Error('migration_invalid_result')
  return value
}
