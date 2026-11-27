import { expect, test } from 'vitest'
import type { MigrationHistoryJobResult } from '../../../shared/generated/contracts'
import { canReconcileLegacyHistory, normalizeHistoryExecution } from './migrationHistoryExecution'
const job = { job: { cancelRequested: false }, workerRunning: false, workerError: null } as MigrationHistoryJobResult

test('an opted-in missing or null observation is unknown while old DTOs remain unchanged', () => {
  expect(normalizeHistoryExecution(job, false)).toBe(job)
  for (const value of [job, { ...job, workerState: null }]) {
    expect(normalizeHistoryExecution(value, true)).toMatchObject({ workerState: 'unknown', workerError: 'history_job_execution_unknown' })
  }
  expect(() => normalizeHistoryExecution({ ...job, workerState: 'stopped', workerRunning: true }, true)).toThrow('migration_invalid_result')
})

test('only an explicitly cancelled untracked legacy owner admits a recovery request', () => {
  const legacy = { ...job, job: { ...job.job, cancelRequested: true }, workerState: 'unknown' as const, workerError: 'history_job_execution_untracked' }
  expect(canReconcileLegacyHistory(legacy)).toBe(true)
  expect(canReconcileLegacyHistory({ ...legacy, workerError: 'history_job_execution_unknown' })).toBe(false)
  expect(canReconcileLegacyHistory({ ...legacy, job: { ...legacy.job, cancelRequested: false } })).toBe(false)
})
