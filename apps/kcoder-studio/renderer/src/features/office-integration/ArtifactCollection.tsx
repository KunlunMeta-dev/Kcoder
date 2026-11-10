import { useMemo, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { OfficeArtifactManifest, OfficeVerification } from '../../../../shared/generated/contracts.js'
import { isOfficeArtifactManifest } from '../../../../shared/generated/contractGuards.mjs'
import { OfficeController, type OfficeList } from './controller'
import { OfficeErrorNotice } from './OfficeErrorNotice'
import { ArtifactPresentationView } from './ArtifactPresentationView'
import { CanonicalSourceDetails } from './CanonicalSourceDetails'
export type OfficeTurnPhase = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
export function ArtifactCollection({ controller, threadId, turnId, phase, onExportReady, onActionIntent, loadPage }: { controller: OfficeController; threadId: string; turnId?: string; phase: OfficeTurnPhase; onExportReady: (receipt: unknown) => void; onActionIntent?: (intent: unknown) => void; loadPage?: (cursor: string | undefined, signal: AbortSignal) => Promise<OfficeList<Record<string, unknown>>> }) {
  const { t } = useTranslation('officeIntegration')
  const [items, setItems] = useState<OfficeArtifactManifest[]>([])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const [next, setNext] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [observations,setObservations]=useState<Record<string,OfficeVerification>>({})
  const current = useRef<AbortController | null>(null)
  const scope = controller.scopeKey()
  useEffect(() => () => current.current?.abort(), [scope, threadId, turnId])
  useEffect(() => {
    const abort = new AbortController(); current.current = abort
    void (loadPage ? loadPage(cursors.at(-1), abort.signal) : controller.artifacts(threadId, cursors.at(-1), abort.signal, turnId)).then(result => { if (!abort.signal.aborted) { const manifests=result.items.filter(isOfficeArtifactManifest);setItems(manifests);
      if(phase==='completed') for(const manifest of manifests) void controller.call('artifact/verification',{reference:{id:manifest.id,revision:manifest.revision}},undefined,abort.signal).then(value=>{if(!abort.signal.aborted&&isOfficeArtifactManifest({...manifest,verification:value.verification}))setObservations(previous=>({...previous,[`${manifest.id}@${manifest.revision}`]:value.verification as OfficeVerification}))}).catch(()=>{});
      setNext(result.nextCursor); setError(null) } }).catch(error => { if (!abort.signal.aborted) setError(error) })
    return () => abort.abort()
  }, [controller, threadId, turnId, phase, scope, cursors, refresh, loadPage])
  const resetOwner = useMemo(() => ({}), [scope, threadId, turnId])
  const [previousOwner, setPreviousOwner] = useState(resetOwner)
  if (previousOwner !== resetOwner) { setPreviousOwner(resetOwner); setItems([]); setCursors([undefined]); setError(null); setBusy(null);setObservations({}) }

  const act = async (manifest: OfficeArtifactManifest, action: 'export' | 'verify') => {
    if (busy) return
    const key = `${manifest.id}@${manifest.revision}`; const abort = new AbortController(); current.current = abort; setBusy(key)
    try { const result = await controller.call<Record<string, unknown>>(`artifact/${action}`, { reference: { id: manifest.id, revision: manifest.revision }, ...(action === 'export' ? { format: manifest.format } : {}) }, controller.operation(), abort.signal); if (action === 'export') onExportReady(result.export); else { if(isOfficeArtifactManifest({...manifest,verification:result.verification}))setObservations(previous=>({...previous,[key]:result.verification as OfficeVerification}));setRefresh(value => value + 1) } }
    catch (error) { setError(error) } finally { setBusy(null) }
  }
  return <section className="min-w-0 space-y-4" aria-label={t('artifacts')}>
    <h2 className="text-lg font-medium text-text-primary">{t('artifacts')}</h2>
    {error ? <OfficeErrorNotice error={error} onClose={() => setError(null)} onRead={() => setRefresh(value => value + 1)} /> : null}
    {items.some(manifest => manifest.format === 'xlsx') && <p className="text-sm text-text-secondary">{t('firstSheetOnly')}</p>}
    {items.length === 0 && <p className="text-base text-text-secondary">{t('empty')}</p>}
    <ol className="space-y-4">{items.map(original => {const manifest={...original,verification:observations[`${original.id}@${original.revision}`]??original.verification};return <li key={`${manifest.id}@${manifest.revision}`} className="workbench-card space-y-1 p-5" data-office-kind={manifest.kind}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words text-base font-medium text-text-primary">{manifest.title}</h3><p className="mt-1 text-sm text-text-secondary">{manifest.format.toUpperCase()} · {manifest.bytes.toLocaleString()} B · {manifest.verification.status === 'passed' ? t('verificationPassed') : t('partial')}</p></div><div className="flex gap-2"><Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void act(manifest, 'export')}>{t('download')}</Button><Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void act(manifest, 'verify')}>{t('verify')}</Button></div></div>
      {phase === 'completed' ? <div className="mt-4"><ArtifactPresentationView controller={controller} manifest={manifest} onExportReady={onExportReady} onActionIntent={onActionIntent} /></div> : <p className="mt-3 text-sm text-text-secondary">{t('previewAfterFinal')}</p>}
      <details className="mt-3"><summary className="cursor-pointer text-sm text-text-secondary">{t('source')}</summary><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-secondary">{manifest.sourceRefs.map(source => <li key={`${source.kind}:${source.id}@${source.revision}`} className="break-all">{source.id} · {source.revision}</li>)}</ul><p className="mt-2 break-all font-mono text-xs text-text-secondary">SHA-256 {manifest.sha256}</p></details>
      {phase==='completed'&&<CanonicalSourceDetails controller={controller} manifest={manifest}/>}
    </li>})}</ol>
    <nav className="flex gap-2"><Button variant="ghost" disabled={cursors.length < 2} onClick={() => setCursors(cursors.slice(0, -1))}>{t('previous')}</Button><Button variant="ghost" disabled={!next} onClick={() => { if (next) setCursors([...cursors, next]) }}>{t('next')}</Button></nav>
  </section>
}
