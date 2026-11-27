import { sameInitialResourceSelection } from '../../../shared/migrationInitialResourceLimits'
import { canReconcileLegacyHistory } from './migrationHistoryExecution'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createMigrationApi } from './gatewayMigration'
import type { MigrationHistoryCreateParams, MigrationResourceLimits, MigrationHistoryJobResult, MigrationHistoryJobsResult, MigrationHistorySourcesResult, MigrationSourceKind } from '../../../shared/generated/contracts'
import { isMigrationHistoryJobResult, isMigrationHistoryReinterpretPreviewResult, type MigrationHistoryReinterpretPreviewResult } from '../../../shared/generated/contracts'

const code = (error: unknown) => (error instanceof Error ? error.message : '').match(/\b(?:migration|history|external_history)_[a-z_]+\b/)?.[0] ?? 'error'
const needsRecovery = (value: MigrationHistoryJobResult) => value.job.failureCode === 'history_projection_recovery_required'
const terminal = (value: MigrationHistoryJobResult) => ['normalized', 'cancelled', 'failed'].includes(value.job.stage) && !needsRecovery(value) && !value.workerRunning && value.workerState !== 'running'

/** The target journal owns work; this hook owns only observation, selection and unsent choices. */
export function useMigrationHistory(deviceId: string, workspacePath: string | undefined, isCurrent: () => boolean) {
  const api = useMemo(() => createMigrationApi(deviceId, workspacePath), [deviceId, workspacePath])
  const [kind, setKind] = useState<MigrationSourceKind>('claude-code')
  const [sources, setSources] = useState<MigrationHistorySourcesResult | null>(null)
  const [jobs, setJobs] = useState<MigrationHistoryJobsResult | null>(null)
  const [active, setActive] = useState<MigrationHistoryJobResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reinterpretation, setReinterpretation] = useState<MigrationHistoryReinterpretPreviewResult | null>(null)
  const [observationRevision, setObservationRevision] = useState(0)
  const mounted = useRef(false), running = useRef(false), activeRef = useRef<MigrationHistoryJobResult | null>(null)
  const requests = useRef(new Map<string, string>())
  const creations = useRef(new Map<string, MigrationHistoryCreateParams>())
  const epoch = useRef(0)
  const valid = () => mounted.current && isCurrent()
  const assertCurrent = () => { if (!valid()) throw new Error('migration_scope_changed') }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const accept = (value: MigrationHistoryJobResult) => {
    assertCurrent()
    if (activeRef.current?.job.jobId === value.job.jobId && activeRef.current.job.sequence > value.job.sequence) return
    activeRef.current = value
    setActive(value)
  }
  const perform = async (action: () => Promise<void>) => {
    if (running.current || !valid()) return false
    running.current = true; setBusy(true); setError('')
    try { await action(); return true } catch (cause) { if (valid()) setError(code(cause)); return false }
    finally { running.current = false; if (valid()) setBusy(false) }
  }
  const discover = () => perform(async () => {
    setSources(null)
    const value = await api.historyDiscover({ source: kind }); assertCurrent(); setSources(value)
  })
  const sourcePage = (cursor?: string) => perform(async () => {
    if (!sources) return
    const value = await api.historySources({ catalogId: sources.catalogId, cursor }); assertCurrent(); setSources(value)
  })
  const listJobs = (cursor?: string) => perform(async () => {
    const value = await api.historyJobs({ cursor }); assertCurrent(); setJobs(value)
  })
  const open = (id: string) => perform(async () => {
    const selected = activeRef.current?.job.jobId === id ? epoch.current : ++epoch.current
    const value = await api.historyRead(id); assertCurrent()
    if (epoch.current === selected) {
      accept(value)
      // An explicit refresh re-arms observation after its bounded error retries stop.
      setObservationRevision(before => before + 1)
    }
  })
  const run = async (value: MigrationHistoryJobResult) => {
    if (value.workerState === 'unknown') throw new Error('history_job_execution_unknown')
    try { accept(await api.historyRun({ jobId: value.job.jobId, expectedSequence: value.job.sequence })) }
    catch (cause) {
      // A missing acknowledgement is reconciled, never automatically retried.
      if (valid()) try { accept(await api.historyRead(value.job.jobId)) } catch { /* Preserve the last acknowledged job. */ }
      throw cause
    }
  }
  const importSource = (handle: string, resourceLimits?: MigrationResourceLimits) => perform(async () => {
    if (!sources) return
    ++epoch.current
    const key = `${sources.catalogId}:${handle}`
    const previous = creations.current.get(key)
    if (previous && !sameInitialResourceSelection(previous.resourceLimits ?? undefined, resourceLimits)) throw new Error('migration_resource_initial_intent_changed')
    const intent: MigrationHistoryCreateParams = previous ?? { catalogId: sources.catalogId, sourceHandle: handle, requestId: crypto.randomUUID(), ...(resourceLimits ? { resourceLimits: { ...resourceLimits } } : {}) }
    creations.current.set(key, intent)
    const id = intent.requestId
    let value: MigrationHistoryJobResult
    try { value = await api.historyCreate(intent) }
    catch (cause) {
      // Creation identity was chosen before sending; only its receipt can resolve a lost reply.
      if (!valid()) throw cause
      try { value = await api.historyRead(id) } catch { throw cause }
    }
    accept(value)
    if (!terminal(value)) await run(value)
  })
  const resume = () => perform(async () => {
    let value = activeRef.current
    if (!value || value.workerRunning || value.workerState === 'running') return
    const legacyRecovery = canReconcileLegacyHistory(value)
    if (value.job.stage === 'normalized' && !needsRecovery(value) && !legacyRecovery) return
    if (value.workerState === 'unknown' && !legacyRecovery) throw new Error('history_job_execution_unknown')
    if (value.workerState != null) {
      const selected = epoch.current, original = value
      const fresh = await api.historyRead(original.job.jobId)
      assertCurrent()
      if (selected !== epoch.current) throw new Error('migration_scope_changed')
      if (fresh.job.jobId !== original.job.jobId || fresh.job.sequence < original.job.sequence) throw new Error('migration_invalid_result')
      accept(fresh); value = fresh
      if (fresh.workerRunning || fresh.workerState === 'running') return
      if (fresh.workerState == null || (fresh.workerState === 'unknown' && !(legacyRecovery && canReconcileLegacyHistory(fresh)))) throw new Error('history_job_execution_unknown')
      if (legacyRecovery && !canReconcileLegacyHistory(fresh)) return
    }
    if (legacyRecovery || ['cancelled', 'failed'].includes(value.job.stage)) {
      value = await api.historyResume({ jobId: value.job.jobId, expectedSequence: value.job.sequence }); accept(value)
    }
    // A legacy ownership upgrade is a distinct explicit recovery, not permission to start work.
    if (!legacyRecovery) await run(value)
  })
  const cancel = () => perform(async () => {
    const value = activeRef.current
    if (value) accept(await api.historyCancel(value.job.jobId))
  })
  const prepareReinterpretation = () => perform(async () => {
    const source = activeRef.current, selected = epoch.current
    if (!source?.job.archived || source.workerRunning) return
    setReinterpretation(null)
    const value = await api.historyReinterpretPreview({ sourceJobId: source.job.jobId })
    assertCurrent()
    if (!isMigrationHistoryReinterpretPreviewResult(value) || value.sourceJobId !== source.job.jobId)
      throw new Error('migration_invalid_result')
    if (epoch.current === selected && activeRef.current?.job.jobId === value.sourceJobId)
      setReinterpretation(value)
  })
  const reinterpret = () => perform(async () => {
    const source = activeRef.current, preview = reinterpretation
    if (!source || source.workerRunning || !preview?.canCreate || preview.sourceJobId !== source.job.jobId || preview.sourceSequence !== source.job.sequence) return
    const selected = ++epoch.current
    const key = `reinterpret:${preview.sourceJobId}:${preview.sourceSequence}`
    const requestId = requests.current.get(key) ?? crypto.randomUUID()
    requests.current.set(key, requestId)
    const reconcile = (value: MigrationHistoryJobResult) => {
      assertCurrent()
      if (!isMigrationHistoryJobResult(value) || value.job.jobId !== requestId || value.job.source !== source.job.source)
        throw new Error('migration_invalid_result')
      if (epoch.current !== selected) throw new Error('migration_scope_changed')
      accept(value)
      setReinterpretation(null)
    }
    let value: MigrationHistoryJobResult
    try {
      value = await api.historyReinterpretCreate({ requestId, sourceJobId: preview.sourceJobId, expectedSourceSequence: preview.sourceSequence })
    } catch (cause) {
      // A missing creation reply only permits observation; it never starts the parser automatically.
      if (valid() && epoch.current === selected) {
        try { reconcile(await api.historyRead(requestId)) } catch { /* Keep the original request identity for explicit reconciliation. */ }
      }
      throw cause
    }
    reconcile(value)
    if (!terminal(value)) await run(value)
  })
  const back = () => { epoch.current++; activeRef.current = null; setActive(null) }
  useEffect(() => {
    if (!active || terminal(active) || (!active.workerRunning && active.workerState !== 'running' && !['capturing', 'archiving', 'normalizing'].includes(active.job.stage))) return
    const selected = epoch.current, id = active.job.jobId
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let busyRetries = 0, unchangedReads = 0
    let lastProgress = Date.now()
    const poll = async () => {
      try {
        const value = await api.historyRead(id, { signal: controller.signal })
        if (controller.signal.aborted || !valid() || epoch.current !== selected) return
        busyRetries = 0
        unchangedReads = activeRef.current?.job.sequence === value.job.sequence ? unchangedReads + 1 : 0
        if (!unchangedReads || value.workerRunning || value.workerState === 'running') lastProgress = Date.now()
        accept(value)
        const latest = activeRef.current
        const progressing = latest && (latest.workerRunning || latest.workerState === 'running' || ['capturing', 'archiving', 'normalizing'].includes(latest.job.stage))
        if (latest && !terminal(latest) && progressing) {
          if (!latest.workerRunning && latest.workerState !== 'running' && Date.now() - lastProgress >= 5 * 60_000) setError('history_observation_refresh_required')
          else timer = setTimeout(poll, latest.workerRunning || latest.workerState === 'running' ? 750 : Math.min(5000, 750 * 2 ** Math.min(unchangedReads, 3)))
        }
      } catch (cause) {
        if (!controller.signal.aborted && valid() && epoch.current === selected) {
          if (code(cause) === 'history_catalog_busy' && busyRetries++ < 3) timer = setTimeout(poll, 250)
          else setError(code(cause))
        }
      }
    }
    timer = setTimeout(poll, 300)
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
    // Active identity/running state owns the poll; each response reconciles the sequence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, active?.job.jobId, active?.workerRunning, active?.workerState, observationRevision])
  return { kind, setKind: (value: MigrationSourceKind) => { setKind(value); setSources(null) }, sources, jobs, active, busy, error,
    reinterpretation: reinterpretation && active && reinterpretation.sourceJobId === active.job.jobId && reinterpretation.sourceSequence === active.job.sequence ? reinterpretation : null,
    prepareReinterpretation, reinterpret, discover, sourcePage, listJobs, open, importSource, resume, cancel, back }
}
