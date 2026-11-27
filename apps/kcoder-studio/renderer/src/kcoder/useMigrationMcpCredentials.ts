import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createMigrationApi } from './gatewayMigration'
import type {
  MigrationJobReadResult,
  MigrationMcpCredentialsResult,
  MigrationMcpPrivateField,
} from '../../../shared/generated/contracts'

type Action = 'read' | 'preview' | 'apply' | 'undo'
type Options = {
  deviceId: string
  workspacePath?: string
  job: MigrationJobReadResult
  itemId: string
  isCurrent: () => boolean
  onUpdated: (value: MigrationJobReadResult) => void
}

/** Private-value operations retain native identities and never replay after a lost response. */
export function useMigrationMcpCredentials({
  deviceId,
  workspacePath,
  job,
  itemId,
  isCurrent,
  onUpdated,
}: Options) {
  const api = useMemo(() => createMigrationApi(deviceId, workspacePath), [deviceId, workspacePath])
  const jobId = job.job.jobId
  const scopeKey = JSON.stringify([deviceId, workspacePath ?? '', jobId, itemId])
  const [snapshot, setCurrent] = useState<{
    scopeKey: string
    value: MigrationMcpCredentialsResult
  } | null>(null)
  const [busyState, setBusy] = useState<{ scopeKey: string; value: boolean } | null>(null)
  const [errorState, setError] = useState<{ scopeKey: string; value: string } | null>(null)
  const [intent, setIntent] = useState<{ scopeKey: string; action: Action } | null>(null)
  const current = snapshot?.scopeKey === scopeKey ? snapshot.value : null
  const busy = busyState?.scopeKey === scopeKey && busyState.value
  const error = errorState?.scopeKey === scopeKey ? errorState.value : ''
  const latest = useRef({ job, isCurrent, onUpdated })
  const result = useRef<MigrationMcpCredentialsResult | null>(null)
  const alive = useRef(false)
  const epoch = useRef(0)
  const running = useRef(false)
  const reads = useRef(new Set<AbortController>())
  useEffect(() => {
    const previous = latest.current.job
    latest.current = {
      job:
        previous.job.jobId === job.job.jobId && previous.job.sequence > job.job.sequence
          ? previous
          : job,
      isCurrent,
      onUpdated,
    }
  }, [job, isCurrent, onUpdated])

  const accept = useCallback(
    (value: MigrationMcpCredentialsResult) => {
      if (
        value.job.jobId !== jobId ||
        value.job.sequence < latest.current.job.job.sequence ||
        (result.current?.job.sequence ?? 0) > value.job.sequence
      )
        return
      result.current = value
      setCurrent({ scopeKey, value })
      const merged = { ...latest.current.job, job: value.job }
      latest.current = { ...latest.current, job: merged }
      latest.current.onUpdated(merged)
    },
    [jobId, scopeKey]
  )

  const read = useCallback(async () => {
    const controller = new AbortController()
    reads.current.add(controller)
    try {
      return await api.readMcpCredentials(jobId, { signal: controller.signal })
    } finally {
      reads.current.delete(controller)
    }
  }, [api, jobId])

  const perform = useCallback(
    async (action: Action, operation: () => Promise<MigrationMcpCredentialsResult>) => {
      if (running.current || !alive.current || !latest.current.isCurrent()) return
      const generation = epoch.current
      const valid = () =>
        alive.current && epoch.current === generation && latest.current.isCurrent()
      running.current = true
      if (action !== 'read') setIntent({ scopeKey, action })
      setBusy({ scopeKey, value: true })
      setError({ scopeKey, value: '' })
      try {
        const value = await operation()
        if (valid()) accept(value)
      } catch (cause) {
        if (!valid()) return
        setError({
          scopeKey,
          value:
            (cause instanceof Error ? cause.message : '').match(/\bmigration_[a-z_]+\b/)?.[0] ??
            'error',
        })
        if (action !== 'read') {
          try {
            const recovered = await read()
            if (!valid()) return
            accept(recovered)
            const plan = recovered.plans.filter(plan => plan.itemId === itemId).at(-1)
            if (
              (action === 'apply' && plan?.phase === 'published') ||
              (action === 'undo' && plan?.phase === 'undone') ||
              (action === 'preview' && plan?.phase === 'ready')
            )
              setError({ scopeKey, value: '' })
          } catch {
            /* Reading a receipt does not authorize another mutation. */
          }
        }
      } finally {
        if (valid()) {
          running.current = false
          setBusy({ scopeKey, value: false })
        }
      }
    },
    [accept, itemId, read, scopeKey]
  )

  useEffect(() => {
    alive.current = true
    epoch.current += 1
    running.current = false
    result.current = null
    const generation = epoch.current
    queueMicrotask(() => {
      if (alive.current && epoch.current === generation) void perform('read', read)
    })
    const ownedReads = reads.current
    return () => {
      alive.current = false
      epoch.current += 1
      running.current = false
      for (const controller of ownedReads) controller.abort()
      ownedReads.clear()
    }
  }, [deviceId, workspacePath, jobId, itemId, perform, read])

  const plan = current?.plans.filter(plan => plan.itemId === itemId).at(-1)
  const operate = (undo: boolean) => {
    const value = result.current?.plans.filter(plan => plan.itemId === itemId).at(-1)
    if (!value) return
    void perform(undo ? 'undo' : 'apply', () => {
      const params = {
        jobId,
        planId: value.planId,
        expectedSequence: latest.current.job.job.sequence,
      }
      return undo ? api.undoMcpCredentials(params) : api.applyMcpCredentials(params)
    })
  }
  return {
    current,
    plan,
    busy,
    error,
    refresh: () => void perform('read', read),
    preview: (fields: MigrationMcpPrivateField[], consent: boolean) => {
      if (!consent || !fields.length || !result.current) return
      void perform('preview', () =>
        api.planMcpCredentials({
          jobId,
          itemId,
          expectedSequence: latest.current.job.job.sequence,
          fields,
          consentPrivateValues: consent,
        })
      )
    },
    apply: () => operate(false),
    undo: () => operate(true),
    retryUndo:
      (intent?.scopeKey === scopeKey && intent.action === 'undo') ||
      plan?.undoRequested === true ||
      plan?.phase === 'undoing',
  }
}
