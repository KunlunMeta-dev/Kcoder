import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createMigrationApi } from './gatewayMigration'
import { captureAccountContextRevision } from './accountContextEvents'
import type { MigrationArchiveRetirementPreviewResult, MigrationArchiveRetirementStateResult } from '../../../shared/generated/contracts'

const safe = (error: unknown) => (error instanceof Error ? error.message : '').match(/\b(?:history|external_history|migration)_[a-z_]{1,110}\b/)?.[0] ?? 'external_history_retirement_outcome_unknown'
interface Data {
  preview: MigrationArchiveRetirementPreviewResult | null
  result: MigrationArchiveRetirementStateResult | null
  items: MigrationArchiveRetirementStateResult[]
  pages: Array<string | null>
  next: string | null
  busy: boolean
  error: string
}
const EMPTY: Data = { preview: null, result: null, items: [], pages: [null], next: null, busy: false, error: '' }
export function useMigrationRetirement(input: { deviceId: string; workspacePath?: string; jobId: string; isCurrent: () => boolean }) {
  const { deviceId, workspacePath, jobId } = input
  const api = useMemo(() => createMigrationApi(deviceId, workspacePath), [deviceId, workspacePath])
  const scope = useMemo(() => ({ api, jobId, deviceId, account: captureAccountContextRevision() }), [api, jobId, deviceId])
  const current = useRef(scope), mounted = useRef(false), active = useRef(input.isCurrent)
  useLayoutEffect(()=>{current.current=scope;active.current=input.isCurrent},[scope,input.isCurrent])
  const latest = useRef<MigrationArchiveRetirementStateResult | null>(null), request = useRef<string | null>(null), mutation = useRef(false)
  const [state, setState] = useState<Data & { scope: typeof scope }>({ ...EMPTY, scope })
  const data = state.scope === scope ? state : EMPTY
  const valid = useCallback(() => mounted.current && current.current === scope && active.current() && scope.account(deviceId), [scope, deviceId])
  const update = useCallback((patch: Partial<Data>) => { if (valid()) setState(old => ({ ...(old.scope === scope ? old : EMPTY), ...patch, scope })) }, [scope, valid])
  const accept = useCallback((result: MigrationArchiveRetirementStateResult) => {
    if (!valid()) return
    const old = latest.current?.retirement, next = result.retirement
    if (next.jobId !== jobId || old && old.operationId !== next.operationId) throw new Error('history_job_retirement_binding_changed')
    if (old && (next.sequence < old.sequence || next.cancelRevision < old.cancelRevision || old.logicalRetired && !next.logicalRetired || next.collectedBytes < old.collectedBytes)) return
    latest.current = result
    setState(previous => {
      if (!valid()) return previous
      const base = previous.scope === scope ? previous : { ...EMPTY, scope }
      return { ...base, result, items: base.items.map(item => item.retirement.operationId === next.operationId ? result : item) }
    })
  }, [jobId, scope, valid])
  const refresh = useCallback(async () => {
    if (!valid()) return
    try {
      const preview = await api.retirementPreview({ jobId })
      if (!valid()) return
      if (preview.existing) accept(preview.existing)
      else if (latest.current) throw new Error('history_retirement_recovery_required')
      update({ preview, error: '' })
    } catch (error) { update({ error: safe(error) }) }
  }, [api, jobId, valid, accept, update])
  useEffect(() => {
    mounted.current = true; latest.current = null; request.current = null; mutation.current = false
    let live=true
    void Promise.resolve().then(()=>{if(live)void refresh()})
    return () => { live=false;mounted.current = false }
  }, [scope, refresh])
  const running = data.result?.workerState === 'running' || data.result?.workerScheduled === true
  useEffect(() => {
    const operation = data.result?.retirement.operationId
    if (!running || !operation) return
    let stopped = false, timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      try {
        const result = await api.retirementRead({ jobId, operationId: operation })
        if (stopped || !valid()) return
        accept(result)
        if (result.workerState === 'running' || result.workerScheduled) timer = setTimeout(() => void poll(), 1000)
      } catch (error) { if (!stopped) update({ error: safe(error) }) }
    }
    timer = setTimeout(() => void poll(), 500)
    return () => { stopped = true; if (timer !== null) clearTimeout(timer) }
  }, [running, data.result?.retirement.operationId, api, jobId, valid, accept, update])
  const page = useCallback(async (cursor: string | null, direction: 'first' | 'next' | 'previous') => {
    if (!valid() || mutation.current) return
    update({ busy: true })
    try {
      const result = await api.retirementList({ cursor })
      if (!valid()) return
      setState(old => {
        if (old.scope !== scope) return old
        const pages = direction === 'first' ? [null] : direction === 'next' ? [...old.pages, cursor] : old.pages.slice(0, -1)
        const latestResult=latest.current;
        const items=result.items.map(item=>latestResult?.retirement.operationId===item.retirement.operationId&&latestResult.retirement.sequence>item.retirement.sequence?latestResult:item);
        return { ...old, items, next: result.nextCursor ?? null, pages, error: '' }
      })
    } catch (error) { update({ error: safe(error) }) }
    finally { update({ busy: false }) }
  }, [api, scope, valid, update])
  const perform = useCallback(async (action: 'prepare' | 'run' | 'resume' | 'cancel', expected: MigrationArchiveRetirementStateResult | null, releaseView?: () => Promise<void>) => {
    if (!valid() || mutation.current) return false
    mutation.current = true; update({ busy: true, error: '' })
    try {
      const preview = await api.retirementPreview({ jobId })
      if (!valid()) return false
      update({ preview })
      if (action === 'prepare') {
        if (!preview.canPrepare) throw new Error(preview.reasonCode ?? 'history_job_retirement_legacy_retained')
        if (preview.existing) { accept(preview.existing); return true }
        request.current ??= crypto.randomUUID()
        accept(await api.retirementPrepare({ operationId: request.current, jobId, expectedJobSequence: preview.jobSequence }))
      } else {
        const fresh = preview.existing
        if (!fresh || !expected || fresh.retirement.operationId !== expected.retirement.operationId || fresh.retirement.sequence !== expected.retirement.sequence || fresh.retirement.cancelRevision !== expected.retirement.cancelRevision)
          throw new Error('external_history_retirement_stale_sequence')
        if (action !== 'cancel' && (fresh.workerState === 'running' || fresh.workerScheduled)) throw new Error('external_history_retirement_execution_busy')
        if (action === 'run' || action === 'resume') {
          if (action === 'run' && fresh.workerState !== 'stopped') throw new Error('external_history_retirement_execution_unknown')
          await releaseView?.()
          if (!valid()) return false
        }
        const params = { operationId: fresh.retirement.operationId, jobId, expectedSequence: fresh.retirement.sequence }
        const result = action === 'run' ? await api.retirementRun(params) : action === 'resume' ? await api.retirementResume(params) : await api.retirementCancel({ operationId: params.operationId, jobId })
        accept(result)
      }
      return valid()
    } catch (error) { update({ error: safe(error) }); return false }
    finally { if (valid()) mutation.current = false; update({ busy: false }) }
  }, [api, jobId, valid, accept, update])
  return { ...data, scope, running, refresh, page, perform, valid }
}
