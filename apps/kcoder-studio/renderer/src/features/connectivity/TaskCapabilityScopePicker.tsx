import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { IntegrationTaskCapabilitySourceDescriptor, IntegrationTaskCapabilityScopeSelection, IntegrationTaskCapabilityScopeSnapshot } from '../../../../shared/generated/contracts'
import { sourceChoiceKey, sourceChoice, replaceSourceChoice, validTaskCapabilityScopeSelection } from './task-capability-scope-selection'
import type { TaskCapabilitySourceObservation } from '@/kcoder/taskCapabilitySourceObservations'
export type { TaskCapabilitySourceObservation } from '@/kcoder/taskCapabilitySourceObservations'
export interface TaskCapabilityScopeCommit { threadId: string; expectedRevision: number; ownerKey: string; selection: IntegrationTaskCapabilityScopeSelection }
interface Props {
  snapshot: IntegrationTaskCapabilityScopeSnapshot
  ownerKey: string
  descriptors: IntegrationTaskCapabilitySourceDescriptor[]
  catalogState: 'observed' | 'unknown' | 'truncated'
  observations?: Record<string, TaskCapabilitySourceObservation>
  onCommit?: (request: TaskCapabilityScopeCommit) => Promise<void>
  readOnly?: boolean
}
function EditableTaskCapabilityScopePicker({ snapshot, ownerKey, descriptors, catalogState, observations = {}, onCommit }: Props) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh'), groupId = useId()
  const [draft, setDraft] = useState(snapshot.selection), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [query, setQuery] = useState(''), [page, setPage] = useState(0)
  const fence = useRef(0), originalOwner = useRef(ownerKey), rememberedChoices = useRef(snapshot.selection.sources)
  useEffect(() => { const lifetime = fence; return () => { lifetime.current++ } }, [])
  const selected = new Set(draft.sources.map(sourceChoiceKey))
  const adopted = new Set(snapshot.effectiveSources.map(sourceChoiceKey))
  const saved = new Set(snapshot.selection.sources.map(sourceChoiceKey))
  const availableKeys = new Set(descriptors.map(value => sourceChoiceKey(sourceChoice(value))))
  const missing = draft.mode === 'selected' ? draft.sources.filter(value => !availableKeys.has(sourceChoiceKey(value))) : []
  const filtered = useMemo(() => descriptors.filter(value => [value.displayName, value.accountDisplayName ?? ''].join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase())), [descriptors, query])
  const rows = filtered.slice(page * 10, page * 10 + 10)
  const valid = validTaskCapabilityScopeSelection(draft) && Number.isSafeInteger(snapshot.revision) && snapshot.revision > 0
  const changed = JSON.stringify(draft) !== JSON.stringify(snapshot.selection)
  const commit = async () => {
    if (!onCommit || !valid || busy || !changed || ownerKey !== originalOwner.current) return
    const generation = fence.current; setBusy(true); setNotice('')
    try {
      await onCommit({ threadId: snapshot.threadId, expectedRevision: snapshot.revision, ownerKey, selection: structuredClone(draft) })
      if (generation === fence.current) setNotice(zh ? '已提交保存，请以任务返回的设置为准。' : 'Submitted. The task response determines the saved setting.')
    } catch { if (generation === fence.current) setNotice(zh ? '暂时无法确认保存结果，请重新读取该任务设置。' : 'The save outcome is unconfirmed. Reload this task’s setting.') }
    finally { if (generation === fence.current) setBusy(false) }
  }
  return <section className="studio-card-spacing grid gap-3 rounded-lg border border-border bg-surface text-sm" aria-label={zh ? '任务工具与资源范围' : 'Task tools and resource scope'} aria-busy={busy}>
    <div className="grid gap-1"><h3 className="text-base font-medium">{zh ? '任务工具与资源范围' : 'Task tools and resource scope'}</h3><p className="text-text-secondary">{zh ? '选择本任务可使用的工具提供方。账户登录和资料访问权限分别检查。' : 'Choose tool providers for this task. Account login and resource access are checked separately.'}</p></div>
    <fieldset className="flex flex-wrap gap-3" disabled={busy}><legend className="sr-only">{zh ? '采用范围' : 'Adoption mode'}</legend>{([['inherit_current', zh ? '沿用当前会话' : 'Inherit this session'], ['selected', zh ? '仅使用所选工具提供方' : 'Selected tool providers only'], ['none', zh ? '不使用外部工具提供方' : 'No external tool providers']] as const).map(([mode, label]) => <label className="flex min-h-11 items-center gap-2" key={mode}><input type="radio" name={groupId} checked={draft.mode === mode} onChange={() => { if (draft.mode === 'selected') rememberedChoices.current = draft.sources; setDraft({ mode, sources: mode === 'selected' ? rememberedChoices.current : [] }); setNotice('') }} />{label}</label>)}</fieldset>
    {draft.mode === 'none' && <p className="text-text-secondary">{zh ? '本地文件和内置能力仍按原有权限使用。' : 'Local files and built-in capabilities retain their existing permission checks.'}</p>}
    {catalogState !== 'observed' && <p role="status" className="text-text-secondary">{catalogState === 'truncated' ? zh ? '当前只列出部分工具提供方。已保存的其他选择会保留。' : 'Only part of the tool provider catalog is listed. Other saved choices are retained.' : zh ? '暂时无法读取当前工具提供方目录。已有范围会保留。' : 'The current tool provider catalog is unavailable. Existing scope choices are retained.'}</p>}
    {draft.mode !== 'none' && <>
      <input className="min-h-11 rounded-md border border-border bg-background px-3" aria-label={zh ? '搜索工具提供方或账户' : 'Search tool providers or accounts'} placeholder={zh ? '搜索工具提供方或账户' : 'Search tool providers or accounts'} value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} />
      <div className="grid gap-2">{rows.map(source => {
        const key = sourceChoiceKey(sourceChoice(source)), checked = draft.mode === 'selected' ? selected.has(key) : adopted.has(key), observed = observations[key], applied = adopted.has(key)
        const account = source.accountDisplayName ?? (source.accountRef === null ? zh ? '无需独立账户' : 'No separate account' : zh ? '账户显示信息未提供' : 'Account display unavailable')
        return <article key={key} className="studio-card-spacing rounded-md border border-border bg-background"><label className="flex min-h-11 items-start gap-3"><input type="checkbox" className="mt-1" checked={checked} disabled={busy || draft.mode !== 'selected' || !checked && source.state !== 'ready'} onChange={event => { setDraft(old => replaceSourceChoice(old, source, event.target.checked)); setNotice('') }} /><span className="min-w-0 flex-1"><span className="block font-medium">{source.displayName}</span><span className="block break-words text-text-secondary">{account}</span><span className="block text-text-muted">{source.state === 'ready' ? zh ? '可选择' : 'Selectable' : source.state === 'unauthorized' ? zh ? '需要授权' : 'Authorization required' : source.state === 'unavailable' ? zh ? '当前不可用' : 'Unavailable' : zh ? '尚未确认' : 'Unknown'}</span></span></label>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-text-muted"><span>{zh ? '安装：' : 'Installed: '}{observed?.installation === 'installed' ? zh ? '已安装' : 'Yes' : observed?.installation === 'not_applicable' ? zh ? '不适用（直接 MCP）' : 'Not applicable (direct MCP)' : zh ? '未确认' : 'Unknown'}</span><span>{zh ? '全局启用：' : 'Global: '}{observed?.globallyEnabled === true ? zh ? '已启用' : 'Enabled' : observed?.globallyEnabled === false ? zh ? '已停用' : 'Disabled' : zh ? '未确认' : 'Unknown'}</span><span>{zh ? '本任务采用：' : 'Task adoption: '}{applied ? zh ? '已采用' : 'Adopted' : checked ? saved.has(key) ? zh ? '待生效' : 'Pending boundary' : zh ? '待保存' : 'Unsaved' : zh ? '未采用' : 'Not adopted'}</span><span>{zh ? '最近连接：' : 'Last connection: '}{observed?.connection === 'ready' ? zh ? '已就绪' : 'Ready' : observed?.connection === 'unavailable' ? zh ? '不可用' : 'Unavailable' : observed?.connection === 'timedOut' ? zh ? '超时' : 'Timed out' : zh ? '未确认' : 'Unknown'}</span><span>{zh ? '实际验证：' : 'Business check: '}{observed?.validation === 'verified' ? zh ? '已验证' : 'Verified' : zh ? '未验证' : 'Not verified'}</span></div>
          {source.reasonCode === 'NATIVE_SOURCE_RETAINED_PLUGIN_VERSION' && <p className="mt-2 text-text-secondary">{zh ? '本会话持有原插件版本的有效租约，继续使用原来源与账户。全局新版本不会替换它，当前停用或撤权仍会阻止访问。' : 'This session holds a valid original plugin version lease and retains its source and account. A global update does not replace it; current disablement or revoked access still blocks use.'}</p>}
          {source.reasonCode === 'NATIVE_SOURCE_REGISTRATION_STALE' && <p className="mt-2 text-text-secondary">{zh ? '来源配置或账户已变化。请重新发现并明确选择新修订；原选择不会自动转授。' : 'Source configuration or account changed. Rediscover and explicitly select the new revision; the original selection is not transferred.'}</p>}
          {source.reasonCode === 'NATIVE_SOURCE_DISABLED' && <p className="mt-2 text-text-secondary">{zh ? '来源已停用。任务选择不会重新启用它；请在原来源设置中处理。' : 'The source is disabled. Task selection does not enable it; review the original source settings.'}</p>}
          {source.state === 'unauthorized' && <p className="mt-2 text-text-secondary">{zh ? '原账户授权不可用或已撤销。请核对原连接，重新授权后再发现；其他账户不会接管。' : 'Original account authorization is unavailable or revoked. Review that connection and rediscover after authorization; another account cannot take over.'}</p>}
          {(observed?.connection === 'unavailable' || observed?.connection === 'timedOut') && <p className="mt-2 text-text-secondary">{zh ? '最近连接尝试失败，不代表授权已撤销或业务未执行。请核对原连接诊断；未知操作先核对原回执。' : 'The last connection attempt failed. This does not prove revoked authorization or an unexecuted action. Inspect the original connection; reconcile unknown actions using their original receipts.'}</p>}
          <details className="mt-2 text-text-muted"><summary>{zh ? '工具提供方与修订' : 'Tool provider and revision'}</summary><p className="break-all">{source.sourceRef.id} · {source.sourceRef.revision}</p>{source.accountRef && <p className="break-all">{source.accountRef.id} · {source.accountRef.revision}</p>}{source.reasonCode && <code>{source.reasonCode}</code>}</details></article>
      })}{!rows.length && <p className="text-text-secondary">{zh ? '没有符合条件的工具提供方。' : 'No matching tool providers.'}</p>}</div>
      {missing.map(choice => <div className="studio-card-spacing flex items-center justify-between gap-3 rounded-md border border-border" key={sourceChoiceKey(choice)}><span className="space-y-1 text-text-secondary"><span className="block">{zh ? '已保存的工具提供方修订未出现在当前目录中，原范围仍会保留。' : 'A saved tool provider revision is absent from this catalog. The original scope is retained.'}</span><span className="block">{zh ? '原会话持有合法插件版本租约时可保留旧版本；提供方变化、权限撤销与连接失败仍分别核对，不会按同名新提供方替换。' : 'A valid original plugin version lease may retain an older version. Provider changes, revoked access and connection failures are checked separately; a same-name replacement is not adopted.'}</span></span><Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(old => ({ mode: 'selected', sources: old.sources.filter(value => sourceChoiceKey(value) !== sourceChoiceKey(choice)) }))}>{zh ? '移除' : 'Remove'}</Button></div>)}
      <div className="flex items-center justify-end gap-2"><Button type="button" variant="outline" disabled={busy || page === 0} onClick={() => setPage(value => value - 1)}>{zh ? '上一页' : 'Previous'}</Button><Button type="button" variant="outline" disabled={busy || (page + 1) * 10 >= filtered.length} onClick={() => setPage(value => value + 1)}>{zh ? '下一页' : 'Next'}</Button></div>
    </>}
    <p className="text-text-secondary">{snapshot.effectiveFrom === 'next_tool_boundary' ? zh ? '更改将在当前操作结束后的下一步生效。' : 'Changes apply at the next safe step after the current operation.' : zh ? '任务会重新核对所选来源及当前权限。' : 'The task rechecks selected sources and current permissions.'}</p>
    {notice && <div role="status" className="flex items-center justify-between gap-3 text-text-secondary"><span>{notice}</span><Button type="button" variant="ghost" onClick={() => setNotice('')}>{zh ? '关闭提示' : 'Dismiss'}</Button></div>}
    <div className="flex items-center gap-3"><Button type="button" disabled={!onCommit || !valid || !changed || busy} onClick={() => void commit()}>{zh ? '保存任务工具与资源范围' : 'Save task tools and resource scope'}</Button><span className="text-text-muted">{zh ? '设置不会自动登录或启用连接器。' : 'Setting a scope does not sign in or enable connectors.'}</span></div>
  </section>
}


/** Read-only records must not expose a draft or a pretend save callback. */
export function TaskCapabilityScopePicker(props: Props) {
  return props.readOnly ? <TaskCapabilityScopeRecordSnapshot {...props} /> : <EditableTaskCapabilityScopePicker key={JSON.stringify([props.ownerKey, props.snapshot.threadId, props.snapshot.revision])} {...props} />
}
function TaskCapabilityScopeRecordSnapshot({ snapshot, descriptors }: Props) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh')
  const renderSources = (values: IntegrationTaskCapabilityScopeSelection['sources']) => <ul className="space-y-2">{values.map(choice => {
    const found = descriptors.find(descriptor => sourceChoiceKey(sourceChoice(descriptor)) === sourceChoiceKey(choice))
    return <li key={sourceChoiceKey(choice)} className="space-y-1 rounded-lg border border-border p-3"><p className="break-words text-sm text-text-primary">{found?.displayName ?? choice.sourceRef.id}</p>{found?.accountDisplayName && <p className="text-sm text-text-secondary">{found.accountDisplayName}</p>}<details className="text-xs text-text-muted"><summary>{zh ? '工具提供方与修订' : 'Tool provider and revision'}</summary><p className="mt-2 break-all">{choice.sourceRef.id} · {choice.sourceRef.revision}</p>{choice.accountRef && <p className="break-all">{choice.accountRef.id} · {choice.accountRef.revision}</p>}</details></li>
  })}</ul>
  return <section className="studio-card-spacing space-y-4 rounded-xl border border-border bg-background" data-testid="task-capability-scope-readonly-snapshot">
    <p className="text-sm text-text-secondary">{zh ? '此处只读取原始工具与资源范围快照，不登录、不启用连接器，也不修改任务范围。' : 'This record only reads the original tool and resource scope. It does not sign in, enable connectors or change the task scope.'}</p>
    <p className="text-base font-medium">{snapshot.selection.mode === 'none' ? zh ? '不使用外部工具提供方' : 'No external tool providers' : snapshot.selection.mode === 'selected' ? zh ? '仅使用所选工具提供方' : 'Selected tool providers only' : zh ? '沿用原会话范围' : 'Inherited original session scope'}</p>
    {snapshot.selection.sources.length > 0 && <div className="space-y-2"><h3 className="text-sm font-medium">{zh ? '范围中已选的工具提供方' : 'Selected tool providers in this scope'}</h3>{renderSources(snapshot.selection.sources)}</div>}
    <div className="space-y-2"><h3 className="text-sm font-medium">{zh ? '快照记录的生效工具提供方' : 'Tool providers recorded as effective in this snapshot'}</h3>{snapshot.effectiveSources.length ? renderSources(snapshot.effectiveSources) : <p className="text-sm text-text-secondary">{zh ? '快照未记录外部工具提供方。' : 'No external tool providers were recorded in this snapshot.'}</p>}</div>
    <p className="text-sm text-text-secondary">{snapshot.effectiveFrom === 'next_tool_boundary' ? zh ? '记录的更改等待下一个安全工具边界。' : 'The recorded change is waiting for the next safe tool boundary.' : zh ? '实际执行时仍会重新核对原始来源、身份和权限。' : 'Original sources, identity and permissions are rechecked during actual execution.'}</p>
    <details className="text-xs text-text-muted"><summary>{zh ? '快照修订' : 'Snapshot revision'}</summary><p className="mt-2 break-all">{snapshot.threadId} · r{snapshot.revision}</p></details>
  </section>
}
