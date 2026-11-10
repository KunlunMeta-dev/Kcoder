import { webSearchProbeRejection } from '../../../../shared/webSearchMethods.mjs'
import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { WebSearchStatusReadResult, WebSearchProbeResult } from '../../../../shared/generated/contracts'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { readWebSearchStatus, startWebSearchProbe, readWebSearchProbe, cancelWebSearchProbe } from '@/kcoder/webSearchDiagnostics'

type Props = { serverId: string; mode: 'kcoder' | 'kworker'; threadId?: string; taskId?: string; isCurrent: () => boolean }
function bound(result: WebSearchProbeResult, status: WebSearchStatusReadResult, requestId: string) {
  return result.targetId === status.targetId && result.revision === status.revision && result.requestId === requestId
}
/** The parent key binds target/account/mode. Opening details performs only a status read. */
export function WebSearchDetails({ serverId, mode, threadId, taskId, isCurrent }: Props) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<WebSearchStatusReadResult | null>(null)
  const [probe, setProbe] = useState<WebSearchProbeResult | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [ownedRequest, setOwnedRequest] = useState<{ requestId: string; expectedRevision: string } | null>(null)
  const active = useRef(true)
  const generation = useRef(0)
  const owned = useRef<{ requestId: string; expectedRevision: string } | null>(null)
  function setOwnership(binding: { requestId: string; expectedRevision: string } | null) {
    owned.current = binding
    setOwnedRequest(binding)
  }
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      // Cancel exactly this component's accepted or uncertain request.
      if (owned.current) void cancelWebSearchProbe(serverId, owned.current, taskId).catch(() => {})
    }
  }, [serverId, taskId])
  const current = (revision: number) => active.current && isCurrent() && revision === generation.current
  async function load() {
    const revision = ++generation.current
    setBusy(true)
    setNotice('')
    try {
      const result = await readWebSearchStatus(serverId, { mode, ...(threadId ? { threadId } : {}) }, taskId)
      if (current(revision)) {
        if (status && status.revision !== result.revision) setProbe(null)
        setStatus(result)
      }
    } catch (error) {
      if (current(revision)) setNotice(error instanceof Error && error.message.includes('UNSUPPORTED') ? 'unsupported' : 'failed')
    } finally { if (current(revision)) setBusy(false) }
  }
  async function observe(initial: WebSearchProbeResult, snapshot: WebSearchStatusReadResult, revision: number) {
    let result = initial
    for (let attempt = 0; current(revision) && attempt < 120; attempt++) {
      if (!bound(result, snapshot, initial.requestId)) { setNotice('unknown'); return }
      setProbe(result)
      if (result.state !== 'running') {
        if (result.state !== 'unknown') setOwnership(null)
        return
      }
      await new Promise(resolve => setTimeout(resolve, 500))
      if (!current(revision)) return
      result = await readWebSearchProbe(serverId, { requestId: initial.requestId, expectedRevision: snapshot.revision }, taskId)
    }
    if (current(revision)) setNotice('unknown')
  }
  async function start() {
    if (!status || busy || owned.current || !isCurrent()) return
    const revision = ++generation.current
    const requestId = crypto.randomUUID()
    const binding = { requestId, expectedRevision: status.revision }
    setOwnership(binding)
    setBusy(true)
    setNotice('')
    try {
      let result: WebSearchProbeResult
      try {
        result = await startWebSearchProbe(serverId, { ...binding, mode, ...(threadId ? { threadId } : {}) }, taskId)
      } catch (error) {
        const rejection = webSearchProbeRejection(error)
        if (rejection) {
          if (current(revision)) { setOwnership(null); setNotice(rejection === 'policy_denied' ? 'errors.policy_denied' : rejection === 'unsupported' ? 'unsupported' : 'failed') }
          return
        }
        // A missing start receipt is reconciled by a read, never another start.
        result = await readWebSearchProbe(serverId, binding, taskId)
      }
      if (current(revision)) await observe(result, status, revision)
    } catch { if (current(revision)) setNotice('unknown') }
    finally { if (current(revision)) setBusy(false) }
  }
  async function reconcile() {
    if (!owned.current || !status || busy) return
    const revision = ++generation.current
    setBusy(true)
    setNotice('')
    try {
      const result = await readWebSearchProbe(serverId, owned.current, taskId)
      if (current(revision)) await observe(result, status, revision)
    } catch { if (current(revision)) setNotice('unknown') }
    finally { if (current(revision)) setBusy(false) }
  }
  async function cancel() {
    if (!owned.current) return
    const revision = ++generation.current
    setBusy(true)
    setNotice('stopping')
    try {
      const result = await cancelWebSearchProbe(serverId, owned.current, taskId)
      if (!current(revision)) return
      if (!status || !bound(result, status, owned.current.requestId)) { setNotice('unknown'); return }
      setProbe(result)
      setNotice('')
      if (result.state !== 'unknown') setOwnership(null)
    } catch { if (current(revision)) setNotice('unknown') }
    finally { if (current(revision)) setBusy(false) }
  }
  const outcome = probe?.state === 'completed' ? probe.response?.status ?? 'unknown' : probe?.state
  return <div className="mt-2 text-sm text-text-secondary" data-testid="web-search-details">
    <button type="button" className="flex min-h-11 items-center gap-1 rounded-md text-sm hover:text-text-primary" aria-expanded={open} onClick={() => { setOpen(!open); if (!open && !status) void load() }}>
      <ChevronRight aria-hidden="true" className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`} />
      {t('web_search.details')}
    </button>
    {open && <div className="space-y-2 py-2" aria-live="polite">
      {busy && !status && <p role="status">{t('web_search.loading')}</p>}
      {status && <>
        <p>{t(`web_search.${status.webSearchVisible ? status.candidates.length === 0 ? 'source_restricted' : status.automatic ? 'automatic' : 'specified' : 'restricted'}`)}</p>
        <p>{t('web_search.reading_state', { state: t(`web_search.${status.webFetchVisible ? 'available' : 'restricted'}`) })}</p>
        <p className="break-words">{status.candidates.join(' → ')}</p>
        {status.observations.filter(item => status.candidates.includes(item.provider)).map(item => <p key={item.provider}>{item.provider}: {t(item.status ? `web_search.observed.${item.status}` : `web_search.${item.component === 'unavailable' ? 'component_unavailable' : 'unobserved'}`)}</p>)}
        <p>{t('web_search.probe_notice')}</p>
        {outcome && <p role="status">{t(`web_search.${outcome}`, { count: probe?.response?.page.results.length ?? 0 })}</p>}
        {probe?.response?.failure && <p>{t(`web_search.errors.${probe.response.failure}`)}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!status.webSearchVisible || busy || Boolean(ownedRequest)} onClick={() => void start()}>{t('web_search.check')}</Button>
          {ownedRequest && <><Button size="sm" variant="ghost" disabled={busy} onClick={() => void reconcile()}>{t('web_search.refresh')}</Button><Button size="sm" variant="ghost" disabled={notice === 'stopping'} onClick={() => void cancel()}>{t('web_search.cancel')}</Button></>}
          {!ownedRequest && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>{t('web_search.refresh')}</Button>}
        </div>
      </>}
      {notice && <p role={notice === 'stopping' ? 'status' : 'alert'}>{t(`web_search.${notice}`)}</p>}
    </div>}
  </div>
}
