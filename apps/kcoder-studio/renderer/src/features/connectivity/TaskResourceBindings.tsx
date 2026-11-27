import { useMemo, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { isContract } from '../../../../shared/generated/validator.mjs'
import type { IntegrationTaskResourceBinding, IntegrationTaskResourceRef, IntegrationTaskCapabilityScopeSnapshot } from '../../../../shared/generated/contracts'
import type { ConnectionList } from './types'
import { sourceChoiceKey } from './task-capability-scope-selection'

interface Candidate { key: string; label: string; binding: IntegrationTaskResourceBinding; reference: IntegrationTaskResourceRef }
interface Props {
  snapshot: IntegrationTaskCapabilityScopeSnapshot
  readOnly: boolean
  load: (after?: string, signal?: AbortSignal) => Promise<ConnectionList>
  save: (bindings: IntegrationTaskResourceBinding[]) => Promise<void>
}
const keyFor = (binding: IntegrationTaskResourceBinding, reference: IntegrationTaskResourceRef) => JSON.stringify([sourceChoiceKey(binding.source), binding.connectionRef.id, binding.connectionRef.revision, reference.kind, reference.id, reference.revision])
export function TaskResourceBindings({ snapshot, readOnly, load, save }: Props) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh')
  const [candidates, setCandidates] = useState<Candidate[]>([]), [selected, setSelected] = useState<Set<string>>(() => new Set((snapshot.resourceBindings ?? []).flatMap(binding => binding.resourceRefs.map(reference => keyFor(binding, reference)))))
  const [next, setNext] = useState<string | null>(null), [busy, setBusy] = useState(true), [notice, setNotice] = useState('')
  const lifetime = useRef({ active: false, generation: 0 }), pending = useRef<AbortController | null>(null)
  const resetOwner = useMemo(() => ({}), [load, snapshot, zh])
  const [previousOwner, setPreviousOwner] = useState(resetOwner)
  if (previousOwner !== resetOwner) { setPreviousOwner(resetOwner); setSelected(new Set((snapshot.resourceBindings ?? []).flatMap(binding => binding.resourceRefs.map(reference => keyFor(binding, reference))))); setCandidates([]); setNext(null); setNotice(''); setBusy(true) }
  useEffect(() => {
    const owner = lifetime.current, reads = pending
    owner.active = true
    const controller = new AbortController(); reads.current = controller
    const generation = ++owner.generation
    void load('', controller.signal).then(page => {
      if (owner.active && generation === owner.generation) { setCandidates(resolveCandidates(page, snapshot, zh)); setNext(page.nextCursor) }
    }).catch(() => { if (owner.active && generation === owner.generation) setNotice(zh ? '当前应用资料无法确认，请刷新应用连接后重试。' : 'Application resources are unconfirmed. Refresh their connections and retry.') })
      .finally(() => { if (owner.active && generation === owner.generation) setBusy(false) })
    return () => { owner.active = false; owner.generation++; reads.current?.abort() }
  }, [load, snapshot, zh])
  const more = async () => {
    if (!next || busy) return
    const owner = lifetime.current, generation = ++owner.generation, controller = new AbortController(); pending.current?.abort(); pending.current = controller; setBusy(true)
    try { const page = await load(next, controller.signal); if (owner.active && generation === owner.generation) { setCandidates(old => [...new Map([...old, ...resolveCandidates(page, snapshot, zh)].map(item => [item.key, item])).values()]); setNext(page.nextCursor) } }
    catch { if (owner.active && generation === owner.generation) setNotice(zh ? '下一页资料尚未确认。' : 'The next resource page is unconfirmed.') }
    finally { if (owner.active && generation === owner.generation) setBusy(false) }
  }
  const commit = async () => {
    const owner = lifetime.current, generation = ++owner.generation; setBusy(true); setNotice('')
    const groups = new Map<string, IntegrationTaskResourceBinding>()
    for (const candidate of candidates.filter(item => selected.has(item.key))) {
      const key = JSON.stringify([sourceChoiceKey(candidate.binding.source), candidate.binding.connectionRef.id, candidate.binding.connectionRef.revision])
      const group = groups.get(key) ?? { ...candidate.binding, resourceRefs: [] }
      group.resourceRefs.push(candidate.reference); groups.set(key, group)
    }
    try { await save([...groups.values()]); if (owner.active && generation === owner.generation) setNotice(zh ? '已提交本任务的资料范围。' : 'Submitted this task’s resource scope.') }
    catch { if (owner.active && generation === owner.generation) setNotice(zh ? '保存结果尚未确认，请核对原保存。' : 'The save is unconfirmed. Reconcile the original save.') }
    finally { if (owner.active && generation === owner.generation) setBusy(false) }
  }
  return <section className="studio-card-spacing space-y-3 rounded-lg border border-border" aria-label={zh ? '本任务应用资料' : 'Task application resources'}>
    <h3 className="text-sm font-medium">{zh ? '本任务应用资料' : 'Task application resources'}</h3>
    <p className="text-sm text-text-secondary">{zh ? '从应用连接已授权的资料中选择。空选择会禁止本任务读取应用资料，来源设置仍分别生效。' : 'Choose from resources already granted to application connections. An empty selection prevents application reads; source settings also remain in force.'}</p>
    {snapshot.resourceBindings == null && <p className="text-xs text-text-muted">{zh ? '当前任务尚未单独设置资料范围。选择后点击保存才会生效。' : 'This task has no separate resource scope. Choose resources and save to apply one.'}</p>}
    {candidates.map(item => <label key={item.key} className="flex min-h-11 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"><input type="checkbox" disabled={busy || readOnly} checked={selected.has(item.key)} onChange={event => setSelected(old => { const values = new Set(old); if (event.target.checked) values.add(item.key); else values.delete(item.key); return values })} /><span className="min-w-0 truncate">{item.label}</span></label>)}
    {!busy && !candidates.length && <p className="text-sm text-text-muted">{zh ? '暂无与本任务所选工具提供方匹配的已授权资料，可先在应用连接中选择。' : 'No granted resources match this task’s selected tool providers. Select resources in the application connection first.'}</p>}
    {notice && <p role="status" className="text-sm text-text-secondary">{notice}</p>}
    <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy || readOnly || Boolean(next)} onClick={() => void commit()}>{zh ? '保存本任务资料范围' : 'Save task resource scope'}</Button>{next && <Button type="button" variant="ghost" disabled={busy || readOnly} onClick={() => void more()}>{zh ? '读取更多应用连接' : 'Load more application connections'}</Button>}</div>
  </section>
}

function resolveCandidates(page: ConnectionList, snapshot: IntegrationTaskCapabilityScopeSnapshot, zh: boolean): Candidate[] {
  const choices = new Set(snapshot.effectiveSources.map(sourceChoiceKey)), result: Candidate[] = []
  for (const connection of page.items) {
    const configured = connection.configuration as { mcpServerName?: unknown; pluginId?: unknown }
    const source = page.sources?.find(item => item.name === configured.mcpServerName && (item.pluginId ?? null) === (configured.pluginId ?? null))
    if (!source?.taskSourceChoice || !isContract('IntegrationTaskCapabilitySourceChoice', source.taskSourceChoice) || !choices.has(sourceChoiceKey(source.taskSourceChoice))) continue
    const binding: IntegrationTaskResourceBinding = { source: source.taskSourceChoice, connectionRef: { id: connection.id, revision: connection.revision }, resourceRefs: [] }
    for (const raw of connection.resourceGrants ?? []) {
      if (!isContract('IntegrationTaskResourceRef', raw)) continue
      const reference = raw as IntegrationTaskResourceRef
      if (!['document', 'spreadsheet', 'mailbox', 'base', 'table'].includes(reference.kind)) continue
      result.push({ key: keyFor(binding, reference), label: `${connection.label} · ${{ document: zh ? '文档' : 'Document', spreadsheet: zh ? '表格' : 'Spreadsheet', mailbox: zh ? '邮件' : 'Mail', base: zh ? '数据集' : 'Dataset', table: zh ? '数据表' : 'Table' }[reference.kind]} ${result.length + 1}`, binding, reference })
    }
  }
  return result
}
