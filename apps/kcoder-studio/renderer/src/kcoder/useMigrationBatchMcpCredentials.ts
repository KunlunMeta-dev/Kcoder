import { useEffect, useMemo, useRef, useState } from 'react'
import { createMigrationApi } from './gatewayMigration'
import type {
  MigrationJobReadResult,
  MigrationMcpCredentialsResult,
} from '../../../shared/generated/contracts'

/** Grouped details are observations; only the batch journal may authorize mutations. */
export function useMigrationBatchMcpCredentials(
  deviceId: string,
  workspacePath: string | undefined,
  job: MigrationJobReadResult | null,
  isCurrent: () => boolean
) {
  const api = useMemo(() => createMigrationApi(deviceId, workspacePath), [deviceId, workspacePath])
  const jobId = job?.job.jobId
  const sequence = job?.job.sequence
  const scope = JSON.stringify([deviceId, workspacePath ?? '', jobId])
  const [attempt, setAttempt] = useState(0)
  const [snapshot, setSnapshot] = useState<{
    scope: string
    sequence: number
    attempt: number
    supported: boolean
    error: string
    result?: MigrationMcpCredentialsResult
  } | null>(null)
  const latest = useRef(isCurrent)
  useEffect(() => {
    latest.current = isCurrent
  }, [isCurrent])
  useEffect(() => {
    if (!jobId || sequence == null) return
    const controller = new AbortController()
    let stopped = false
    const valid = () => !stopped && !controller.signal.aborted && latest.current()
    void Promise.resolve().then(async () => {
      if (!valid()) return
      try {
        const result = await api.readBatchMcpCredentials(jobId, { signal: controller.signal })
        if (!valid()) return
        if (result.job.jobId !== jobId || result.job.sequence < sequence)
          throw new Error('migration_stale_cursor')
        setSnapshot({ scope, sequence, attempt, supported: true, error: '', result })
      } catch (cause) {
        if (!valid()) return
        const code =
          (cause instanceof Error ? cause.message : '').match(/\bmigration_[a-z_]+\b/)?.[0] ??
          'error'
        setSnapshot({
          scope,
          sequence,
          attempt,
          supported: code !== 'migration_update_required',
          error: code === 'migration_update_required' ? '' : code,
        })
      }
    })
    return () => {
      stopped = true
      controller.abort()
    }
  }, [api, jobId, sequence, scope, attempt])
  const current =
    snapshot?.scope === scope && snapshot.sequence === sequence && snapshot.attempt === attempt
      ? snapshot
      : null
  return {
    plans: current?.result?.plans ?? [],
    supported: current?.supported ?? false,
    loading: Boolean(jobId) && !current,
    error: current?.error ?? '',
    refresh: () => setAttempt(value => value + 1),
  }
}
