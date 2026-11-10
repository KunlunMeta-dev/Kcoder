import { useMemo, useEffect, useRef, useState, useLayoutEffect } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { OfficeArtifactManifest,OfficeCanonicalSourceReadResult } from '../../../../shared/generated/contracts.js'
import { OfficeController } from './controller'

export function CanonicalSourceDetails({controller,manifest}:{controller:OfficeController;manifest:OfficeArtifactManifest}) {
  const {t}=useTranslation('officeIntegration')
  const [metadata,setMetadata]=useState<OfficeCanonicalSourceReadResult|null>(null)
  const [error,setError]=useState(false);const [text,setText]=useState<string|null>(null);const [busy,setBusy]=useState(false)
  const pending=useRef<AbortController|null>(null);const scope=controller.scopeKey();const owner=useRef(scope)
  useLayoutEffect(()=>{owner.current=scope},[scope])
  const resetOwner = useMemo(() => ({}), [controller, scope, manifest.id, manifest.revision])
  const [previousOwner, setPreviousOwner] = useState(resetOwner)
  if (previousOwner !== resetOwner) { setPreviousOwner(resetOwner); setMetadata(null);setText(null);setError(false);setBusy(false) }
  useEffect(()=>{
    const abort=new AbortController();pending.current=abort
    void controller.canonicalSource({id:manifest.id,revision:manifest.revision},abort.signal).then(value=>{if(!abort.signal.aborted&&owner.current===scope)setMetadata(value)}).catch(()=>{if(!abort.signal.aborted&&owner.current===scope)setError(true)})
    return()=>{abort.abort();pending.current?.abort()}
  },[controller,scope,manifest.id,manifest.revision])
  const read=async()=>{
    const abort=new AbortController();pending.current?.abort();pending.current=abort;setBusy(true);setError(false)
    try{const value=await controller.canonicalSourceText({id:manifest.id,revision:manifest.revision},abort.signal);if(!abort.signal.aborted&&owner.current===scope)setText(value)}
    catch{if(!abort.signal.aborted&&owner.current===scope)setError(true)}finally{if(pending.current===abort)setBusy(false)}
  }
  const download=()=>{
    if(text===null)return;const url=URL.createObjectURL(new Blob([text],{type:'application/json;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`generation_source_${manifest.id.replace(/[^A-Za-z0-9_.-]/g,'_').slice(0,80)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),0)
  }
  return <section className="mt-3 space-y-2 text-sm text-text-secondary" aria-label={t('canonicalTitle')}>
    <p>{error?t('canonicalUnavailable'):metadata?.availability==='not_recorded'?t('canonicalMissing'):metadata?.source?t('canonicalSaved'):t('canonicalChecking')}</p>
    {metadata?.source&&<Button variant="ghost" size="sm" disabled={busy} onClick={()=>void read()}>{busy?t('loading'):t('canonicalInspect')}</Button>}
    {busy&&<Button variant="ghost" size="sm" onClick={()=>{pending.current?.abort();setBusy(false)}}>{t('cancel')}</Button>}
    {text!==null&&<details open className="studio-card-spacing rounded-lg border border-border"><summary className="cursor-pointer">{t('canonicalReadonly')}</summary><p className="my-2">{t('canonicalPreviewBounded')}</p><pre className="max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-all rounded bg-surface p-3 font-mono text-xs text-text-primary">{text.slice(0,16_000)}</pre><Button variant="outline" size="sm" className="mt-2" onClick={download}>{t('canonicalDownload')}</Button></details>}
  </section>
}
