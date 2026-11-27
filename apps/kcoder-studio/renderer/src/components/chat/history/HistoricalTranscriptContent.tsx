import {useCallback,useEffect,useRef,useState} from 'react'
import {useTranslation} from '@/hooks/useTranslation'
import type {useMigrationTranscript} from '@/kcoder/useMigrationTranscript'
import {AssistantMarkdown} from '@/components/chat/AssistantMarkdown'
import {Button} from '@/components/ui/button'
import {MigrationHistoryAttachment} from '@/components/settings/MigrationHistoryAttachment'
import {MigrationToolAttachments} from '@/components/settings/MigrationToolAttachments'
import type {MigrationTranscriptPageResult,MigrationTranscriptTextResult} from '../../../../../shared/generated/contracts'
type Model=ReturnType<typeof useMigrationTranscript>
type Row=MigrationTranscriptPageResult['items'][number]
type Block=Row['blocks'][number]

/** Foreign transcript blocks share one inert renderer in settings and ordinary conversations. */
export function HistoricalTranscriptContent({model}:{model:Model}){
  const {t}=useTranslation('migration')
  return <>
    <div className="max-h-96 space-y-5 overflow-y-auto overscroll-contain" data-testid="migration-transcript-scroll">
      {model.rows.map(item=><HistoricalRow key={`${model.scope}:${item.address}`} row={item.row} address={item.address} model={model} sourceSessionId={item.sourceSessionId} replacementIndex={item.replacementIndex} omittedBlocks={item.omittedBlocks}/>)}
      {model.page?.items.length===0&&<p className="text-sm text-text-secondary">{t('transcript.empty')}</p>}
    </div>
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="ghost" disabled={model.busy||!model.previous} onClick={()=>void model.previous?.()}>{t('previous')}</Button>
      <Button size="sm" variant="ghost" disabled={model.busy||!model.next} onClick={()=>void model.next?.()}>{t('next')}</Button>
    </div>
  </>
}

function HistoricalRow({row, address, model, sourceSessionId, replacementIndex, omittedBlocks}: {row: Row, address:number, model: Model, sourceSessionId?:string,replacementIndex?:number|null,omittedBlocks?:number}) {
  const { t } = useTranslation('migration')
  const [blocks, setBlocks] = useState(row.blocks)
  const [next, setNext] = useState(row.nextBlockCursor)
  const [cursors, setCursors] = useState([0])
  const [busy, setBusy] = useState(false), [error, setError] = useState(false)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const load = async (cursor: number, navigation: number[]) => {
    if (busy) return
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(false)
    try {
      const value = await model.blocks(address, cursor, controller.signal)
      if (!controller.signal.aborted) {
        // Replace the ten-block window; an enormous source record never grows this view indefinitely.
        setBlocks(value.blocks); setNext(value.nextCursor); setCursors(navigation)
      }
    } catch { if (!controller.signal.aborted) setError(true) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <article className={row.role === 'user' ? 'ml-auto max-w-full rounded-xl bg-muted px-4 py-3' : 'max-w-full px-1 py-2'} data-testid="historical-record">
    <p className="mb-2 break-words text-xs text-text-muted">{t(`transcript.${row.role ? `roles.${row.role}` : `kinds.${row.kind}`}`)}{row.timestamp ? ` · ${row.timestamp}` : ''}</p>
    {blocks.map(block => <HistoricalBlock key={block.index} block={block} record={address} model={model} />)}
    {(next != null || cursors.length > 1) && <div className="flex gap-2">
      <Button size="sm" variant="ghost" disabled={busy || cursors.length < 2} onClick={() => { const previous = cursors.slice(0, -1); void load(previous.at(-1)!, previous) }}>{t('transcript.previous_blocks')}</Button>
      <Button size="sm" variant="ghost" disabled={busy || next == null} onClick={() => { if (next != null) void load(next, [...cursors, next]) }}>{t('transcript.next_blocks')}</Button>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{t('transcript.read_failed')}</p>}
    <details className="mt-2 text-xs text-text-muted"><summary className="cursor-pointer">{t('transcript.provenance')}</summary>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words"><dt>{t('transcript.record')}</dt><dd>{row.record}</dd>
        {row.sourceId && <><dt>{t('transcript.source_id')}</dt><dd>{row.sourceId}</dd></>}
        {row.parentId && <><dt>{t('transcript.parent_id')}</dt><dd>{row.parentId}</dd></>}
        {sourceSessionId&&<><dt>{t('branch.source_session')}</dt><dd>{sourceSessionId}</dd></>}
        {replacementIndex!=null&&<><dt>{t('branch.replacement')}</dt><dd>{replacementIndex}</dd></>}
        {Boolean(omittedBlocks)&&<><dt>{t('branch.omitted_blocks')}</dt><dd>{omittedBlocks}</dd></>}
        <dt>{t('transcript.diagnostics')}</dt><dd>{row.totalDiagnostics}</dd>
      </dl>
      {row.hidden && <p>{t('transcript.hidden')}</p>}{row.sidechain && <p>{t('transcript.sidechain')}</p>}
      {row.compactSummary && <p>{t('transcript.compacted')}</p>}
      {row.diagnostics.map((item,index) => <p key={index}>{t(`transcript.diagnostic_codes.${item.code}`, {defaultValue: t(item.blocksContinuation ? 'transcript.blocking_diagnostic' : 'transcript.diagnostic')})}</p>)}
    </details>
  </article>
}

function HistoricalBlock({block, record, model}: {block: Block, record: number, model: Model}) {
  const { t } = useTranslation('migration')
  const [expanded, setExpanded] = useState(false)
  if(block.kind==='attachment'&&model.attachmentContext)return <MigrationHistoryAttachment key={`${model.scope}:${record}:${block.index}`} context={model.attachmentContext} position={record} blockIndex={block.index}/>
  if (block.kind === 'attachment' || block.kind === 'opaque')
    return <p className="break-words py-1 text-sm text-text-secondary">{t(`transcript.${block.kind}`)}{block.sourceType ? ` · ${block.sourceType}` : ''}</p>
  const content = <HistoricalBody block={block} record={record} model={model} />
  if (block.kind === 'text') return content
  return <details className="my-2 border-l-2 border-border pl-3" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer break-words text-sm text-text-secondary">{t(`transcript.block_kinds.${block.kind}`)}{block.name ? ` · ${block.namespace ? `${block.namespace}.` : ''}${block.name}` : ''}
      {block.outcome ? ` · ${t(`transcript.outcomes.${block.outcome}`)}` : ''}</summary>
    {expanded && <>{content}{block.kind==='tool_result'&&model.attachmentContext&&<MigrationToolAttachments key={`${model.scope}:${record}:${block.index}`} context={model.attachmentContext} position={record} blockIndex={block.index}/>}</>}
  </details>
}

export function HistoricalBody({block, record, model, initialCursor}: {block: Block, record: number, model: Model, initialCursor?:string}) {
  const { t } = useTranslation('migration')
  const [chunk, setChunk] = useState<MigrationTranscriptTextResult | null>(null)
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const [busy, setBusy] = useState(false), [error, setError] = useState(false)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const text=model.text
  const load = useCallback(async (next: string | undefined, navigation: Array<string | undefined>) => {
    if (busy) return
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(false)
    try { const value = await text(record, block.index, next, controller.signal); if (!controller.signal.aborted) { setChunk(value); setCursors(navigation) } }
    catch { if (!controller.signal.aborted) setError(true) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  },[busy,text,record,block.index])
  useEffect(()=>{
    if(!initialCursor)return
    const controller=new AbortController()
    const timer=setTimeout(()=>{
      request.current?.abort();request.current=controller;setBusy(true);setError(false)
      void text(record,block.index,initialCursor,controller.signal).then(value=>{
        if(!controller.signal.aborted){setChunk(value);setCursors([initialCursor])}
      }).catch(()=>{if(!controller.signal.aborted)setError(true)}).finally(()=>{if(!controller.signal.aborted)setBusy(false)})
    },0)
    return()=>{clearTimeout(timer);controller.abort()}
  },[initialCursor,text,record,block.index])
  const complete = block.preview != null && block.decodedBytes != null && new TextEncoder().encode(block.preview).byteLength === block.decodedBytes
  const prose = block.kind === 'text' || block.kind === 'thinking'
  const value = chunk?.text ?? block.preview ?? ''
  return <div className="my-2 min-w-0" data-testid="historical-body" aria-busy={busy} data-content-page={cursors.length}>
    <div className={chunk ? 'max-h-64 overflow-y-auto overscroll-contain' : ''}>
      {prose ? <AssistantMarkdown content={value} historical /> : <pre className="whitespace-pre-wrap break-words text-code text-text-secondary">{value}</pre>}
    </div>
    {error && <div><p role="alert" className="text-sm text-destructive">{t('transcript.read_failed')}</p>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load(initialCursor, [initialCursor])}>{t('transcript.reload_body')}</Button></div>}
    {!chunk && !complete && block.bodyAvailable && !error && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load(initialCursor, [initialCursor])}>{t('transcript.read_body')}</Button>}
    {chunk && <div className="flex justify-end gap-2">
      <Button size="sm" variant="ghost" disabled={busy || cursors.length < 2} onClick={() => { const previous = cursors.slice(0,-1); void load(previous.at(-1), previous) }}>{t('previous')}</Button>
      <Button size="sm" variant="ghost" disabled={busy || !chunk.nextCursor} onClick={() => { if (chunk.nextCursor) void load(chunk.nextCursor, [...cursors, chunk.nextCursor]) }}>{t('next')}</Button>
    </div>}
  </div>
}
