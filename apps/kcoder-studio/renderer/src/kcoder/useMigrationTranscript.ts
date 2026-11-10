import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createMigrationApi } from './gatewayMigration'
import type { MigrationTranscriptPageResult } from '../../../shared/generated/contracts'

export function useMigrationTranscript(deviceId: string, workspacePath: string | undefined, jobId: string, isCurrent: () => boolean, viewId?: string) {
  const api = useMemo(() => createMigrationApi(deviceId, workspacePath), [deviceId, workspacePath])
  const current = useRef(isCurrent)
  useEffect(() => { current.current = isCurrent }, [isCurrent])
  const mounted = useRef(false)
  const epoch = useRef(0)
  const pending = useRef<AbortController | null>(null)
  const [page, setPage] = useState<MigrationTranscriptPageResult | null>(null)
  const [rows, setRows] = useState<Array<{address:number,row:MigrationTranscriptPageResult['items'][number],sourceSessionId?:string,replacementIndex?:number|null,omittedBlocks?:number}>>([])
  const scope=JSON.stringify([deviceId,workspacePath??null,jobId,viewId??null])
  const [loadedScope,setLoadedScope]=useState('')
  const [cursor, setCursor] = useState(0)
  const [cursors, setCursors] = useState([0])
  const [busy, setBusy] = useState(false)
  const [reconstructed, setReconstructed] = useState(false)
  const [error, setError] = useState('')
  const assertCurrent = useCallback(() => { if (!mounted.current || !current.current()) throw new Error('migration_scope_changed') }, [])
  const load = useCallback(async (position: number, navigation: number[]) => {
    pending.current?.abort()
    const controller = new AbortController(); pending.current = controller
    const generation = ++epoch.current
    setBusy(true); setError('')
    try {
      const selected=viewId ? await api.branchPage({jobId,viewId,cursor:position},{signal:controller.signal}) : null
      const value:MigrationTranscriptPageResult=selected ? {source:selected.progress.source,sourceSessionId:selected.sourceSessionId,title:selected.title,project:null,
        items:selected.items.map(item=>item.record),totalRecords:selected.progress.writtenItems,nextCursor:selected.nextCursor,
        normalizationComplete:true,adapterRevision:`branch:${viewId}`} : await api.transcriptPage({ jobId, cursor: position }, { signal: controller.signal })
      assertCurrent()
      if (!controller.signal.aborted && generation === epoch.current) {
        setPage(value); setCursor(position); setCursors(navigation);setLoadedScope(scope)
        setReconstructed(selected?.progress.issues?.includes('codex_readable_reconstruction_requires_admission') ?? false)
        setRows(selected ? selected.items.map(item=>({address:item.position,row:item.record,sourceSessionId:item.sourceSessionId,replacementIndex:item.replacementIndex,omittedBlocks:item.omittedBlocks}))
          : value.items.map(row=>({address:row.record,row})))
      }
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current && current.current() && generation === epoch.current)
        setError((cause instanceof Error ? cause.message : '').match(/\b(?:migration|history|external_history)_[a-z_]+\b/)?.[0] ?? 'error')
    } finally {
      if (!controller.signal.aborted && mounted.current && generation === epoch.current) setBusy(false)
    }
  }, [api, jobId, assertCurrent, viewId, scope])
  useEffect(() => {
    mounted.current = true
    const timer = setTimeout(() => { if (mounted.current) void load(0, [0]) }, 0)
    return () => { mounted.current = false; clearTimeout(timer); pending.current?.abort() }
  }, [load])
  const blocks = async (record: number, next: number, signal: AbortSignal) => {
    assertCurrent(); const value = viewId ? await api.branchBlocks({jobId,viewId,position:record,cursor:next},{signal}) : await api.transcriptBlocks({ jobId, record, cursor: next }, { signal }); assertCurrent(); return value
  }
  const text = useCallback(async (record: number, blockIndex: number, next: string | undefined, signal: AbortSignal) => {
    assertCurrent(); const value = viewId ? await api.branchText({jobId,viewId,position:record,blockIndex,cursor:next},{signal}) : await api.transcriptText({ jobId, record, blockIndex, cursor: next }, { signal }); assertCurrent(); return value
  },[api,jobId,viewId,assertCurrent])
  const attachmentContext=useMemo(()=>({deviceId,workspacePath,jobId,viewId,isCurrent:()=>{try{assertCurrent();return true}catch{return false}}}),[deviceId,workspacePath,jobId,viewId,assertCurrent])
  return {scope,attachmentContext,page:loadedScope===scope?page:null, reconstructed:loadedScope===scope&&reconstructed, rows:loadedScope===scope?rows:[], cursor, busy, error, blocks, text, refresh: () => load(cursor, cursors),
    previous: cursors.length > 1 ? () => load(cursors.at(-2)!, cursors.slice(0, -1)) : undefined,
    next: page?.nextCursor != null ? () => load(page.nextCursor!, [...cursors, page.nextCursor!]) : undefined}
}
