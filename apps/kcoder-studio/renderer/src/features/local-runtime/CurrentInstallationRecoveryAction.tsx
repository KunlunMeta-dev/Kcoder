import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { SELECTED_SERVER_KEY } from '@/kcoder/gateway/runtime/contracts'
import { readCurrentInstallation, importCurrentInstallation, type CurrentInstallationPreview, type CurrentInstallationReceipt } from './startupCurrentInstallation'

export function CurrentInstallationRecoveryAction({ sourceId, onSelected }: { sourceId?: string; onSelected(): void }) {
  const { t } = useTranslation('localRuntime')
  const [preview, setPreview] = useState<CurrentInstallationPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<'unknown' | 'read' | 'select' | null>(null)
  const [imported, setImported] = useState<CurrentInstallationReceipt>()
  const readSource = useRef('local')
  const reader = useRef<AbortController | null>(null)
  const owner = useRef({ generation: 0, live: true, submitting: false })
  // A different source starts from an empty preview before its read begins.
  const [shownSource, setShownSource] = useState(sourceId)
  if (shownSource !== sourceId) { setShownSource(sourceId); setPreview(null); setFailure(null); setImported(undefined) }
  useEffect(() => {
    const current = owner.current; current.live = true; current.submitting = false
    const generation = ++current.generation, abort = new AbortController()
    reader.current?.abort(); reader.current = abort
    let selected = sourceId
    if (!selected) try { selected = localStorage.getItem(SELECTED_SERVER_KEY) ?? 'local' } catch { selected = 'local' }
    readSource.current = selected
    void readCurrentInstallation(selected, abort.signal).then(value => {
      if (current.live && generation === current.generation) setPreview(value)
    }).catch(() => {
      if (current.live && generation === current.generation) setFailure('read')
    })
    return () => { current.live = false; current.generation++; abort.abort(); reader.current?.abort() }
  }, [sourceId])
  const reconcile = async () => {
    const current = owner.current, generation = ++current.generation
    const abort = new AbortController(); reader.current?.abort(); reader.current = abort
    try {
      const value = await readCurrentInstallation(readSource.current, abort.signal)
      if (!current.live || current.generation !== generation) return
      setPreview(value); setFailure(value?.publicationState === 'unknown' || value?.publicationState === 'publishing' ? 'unknown' : null)
    } catch { if (current.live && current.generation === generation) setFailure('unknown') }
  }
  const select = (result: CurrentInstallationReceipt) => {
    try {
      localStorage.setItem(SELECTED_SERVER_KEY, result.serverId)
      window.dispatchEvent(new CustomEvent('kcoder:servers-changed'))
      onSelected()
    } catch { setFailure('select') }
  }
  const recover = async () => {
    if (busy || owner.current.submitting || !preview || failure === 'unknown') return
    if (imported || preview.receipt) { select(imported ?? preview.receipt!); return }
    if (preview.publicationState !== 'ready') { setFailure('unknown'); return }
    const current = owner.current, generation = current.generation
    current.submitting = true
    setBusy(true); setFailure(null)
    try {
      const name = [...preview.sourceLabel].slice(0, 24).join('')
      const result = await importCurrentInstallation(preview, t('recovery_import_name', { name }))
      if (!current.live || current.generation !== generation) return
      setImported(result); select(result)
    } catch {
      if (current.live && current.generation === generation) setFailure('unknown')
    } finally { if (current.live && current.generation === generation) { current.submitting = false; setBusy(false) } }
  }
  if (!preview) return failure ? <p role="status" className="text-sm text-text-secondary">{t('recovery_import_read_failed')}</p> : null
  return <section className="space-y-3 rounded-lg border border-border bg-surface p-4" data-testid="current-installation-recovery">
    <h2 className="text-sm font-medium">{t('recovery_import_title')}</h2>
    <p className="text-sm text-text-secondary">{t('recovery_import_description')}</p>
    <p className="break-all font-mono text-xs text-text-secondary">{preview.command}</p>
    <Button variant="primary" onClick={() => void recover()} disabled={busy || failure === 'unknown' || ['unknown', 'publishing'].includes(preview.publicationState)} data-testid="startup-use-current-installation">
      {t(busy ? 'recovery_import_pending' : imported || preview.receipt ? 'recovery_import_select' : 'recovery_import_action')}
    </Button>
    {failure && <p role="status" className="text-sm text-text-secondary">{t(`recovery_import_${failure}_failed`)}</p>}
    {(failure === 'unknown' || ['unknown', 'publishing'].includes(preview.publicationState)) && <Button variant="outline" onClick={() => void reconcile()} data-testid="startup-current-installation-reconcile">{t('recovery_import_reconcile')}</Button>}
  </section>
}
