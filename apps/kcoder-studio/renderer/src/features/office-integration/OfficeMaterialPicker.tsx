import { useEffect, useRef, useState, useLayoutEffect } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { OfficeController, type OfficeMaterialReceipt } from './controller'
import { OfficeErrorNotice } from './OfficeErrorNotice'
interface Upload { id: string; file: File; abort: AbortController; progress: number; state: 'queued' | 'uploading' | 'accepted' | 'unknown'; receipt?: OfficeMaterialReceipt; error?: unknown }
export function OfficeMaterialPicker({ controller, onAccepted, onRemoved, onPendingChange, disabled }: { controller: OfficeController; onAccepted: (receipt: OfficeMaterialReceipt) => void; onRemoved?: (receipt: OfficeMaterialReceipt) => void; onPendingChange?: (pending: boolean) => void; disabled?: boolean }) {
  const { t } = useTranslation('officeIntegration')
  const [uploads, setUploads] = useState<Upload[]>([])
  const [tooMany, setTooMany] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const owned = useRef(new Map<string, AbortController>())
  const scope = controller.scopeKey(); const active = useRef(scope)
  useLayoutEffect(() => { active.current = scope }, [scope])
  const [previousScope, setPreviousScope] = useState(scope)
  if (previousScope !== scope) { setPreviousScope(scope); setUploads([]); setTooMany(false) }
  const pending = uploads.some(row => row.state !== 'accepted')
  useEffect(() => { onPendingChange?.(pending) }, [onPendingChange, pending])
  useEffect(() => { active.current = scope; return () => { active.current = `closed:${scope}`; for (const abort of owned.current.values()) abort.abort(); owned.current.clear() } }, [scope])
  const change = (id: string, patch: Partial<Upload>) => setUploads(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row))
  const upload = async (files: File[]) => {
    if (disabled || owned.current.size) return
    if (files.length > 32 - uploads.length) { setTooMany(true); return }
    setTooMany(false)
    const captured = scope
    const rows = files.map(file => ({ id: crypto.randomUUID(), file, abort: new AbortController(), progress: 0, state: 'queued' as const }))
    for (const row of rows) owned.current.set(row.id, row.abort)
    setUploads(previous => [...previous, ...rows])
    // Each input has its own cancellation owner. Sequential admission also stays
    // within the existing native pending-upload budget without a second scheduler.
    for (const row of rows) {
      if (row.abort.signal.aborted || active.current !== captured) { owned.current.delete(row.id); continue }
      change(row.id, { state: 'uploading' })
      try { const receipt = await controller.prepareInput(row.file, row.abort.signal, bytes => change(row.id, { progress: bytes })); if (active.current !== captured || row.abort.signal.aborted) continue; change(row.id, { state: 'accepted', progress: row.file.size, receipt }); onAccepted(receipt) }
      catch (error) { if (active.current === captured) change(row.id, { state: 'unknown', error }) }
      finally { owned.current.delete(row.id) }
    }
  }
  return <div className="space-y-3"><input ref={file} data-testid="office-material-files" type="file" multiple disabled={disabled || uploads.some(row => row.state === 'queued' || row.state === 'uploading')} className="sr-only" aria-label={t('chooseMaterials')} onChange={event => { const files = Array.from(event.target.files ?? []); event.currentTarget.value = ''; void upload(files) }} />
    <Button data-testid="office-material-choose" type="button" variant="outline" disabled={disabled || !controller.supportsInput() || uploads.some(row => row.state === 'queued' || row.state === 'uploading')} onClick={() => file.current?.click()}>{t('chooseMaterials')}</Button>
    {tooMany && <p role="alert" className="text-base text-destructive">{t('tooManyFiles')}</p>}
    <ul className="space-y-3">{uploads.map(row => <li key={row.id} data-testid="office-material-row" className="space-y-2"><div className="flex flex-wrap items-center gap-2 text-sm"><span className="min-w-0 break-all text-text-primary">{row.file.name}</span><span className="text-text-secondary">{row.state === 'accepted' ? t('accepted') : row.state === 'unknown' ? t('failed') : `${t('uploading')} ${row.progress.toLocaleString()} / ${row.file.size.toLocaleString()} B`}</span>{(row.state === 'queued' || row.state === 'uploading') ? <Button type="button" variant="ghost" size="sm" disabled={disabled} data-testid="office-material-cancel" onClick={() => { row.abort.abort(); change(row.id, { state: 'unknown' }) }}>{t('cancel')}</Button> : <Button type="button" variant="ghost" size="sm" disabled={disabled} data-testid="office-material-remove" aria-label={t('removeFile', { filename: row.file.name })} onClick={() => { row.abort.abort(); setUploads(previous => previous.filter(item => item.id !== row.id)); if (row.receipt) onRemoved?.(row.receipt) }}>{t('remove')}</Button>}</div>{row.error ? <OfficeErrorNotice error={row.error} onClose={() => change(row.id, { error: undefined })} /> : null}</li>)}</ul>
  </div>
}
