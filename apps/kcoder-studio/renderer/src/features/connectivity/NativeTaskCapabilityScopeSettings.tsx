import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { createTaskCapabilityScopeSettingsTransport } from '@/kcoder/taskCapabilityScopeSettingsTransport'
import type { TaskCapabilitySourceObservation } from '@/kcoder/taskCapabilitySourceObservations'
import type { TaskWorkspaceTarget } from '@/kcoder/taskWorkspaceTransport'
import type { IntegrationTaskCapabilitySourceChoicesPage, IntegrationTaskCapabilityScopeControlTarget, IntegrationTaskCapabilitySourceDescriptor, IntegrationTaskCapabilityScopeSnapshot } from '../../../../shared/generated/contracts'
import { TaskCapabilityScopePicker } from './TaskCapabilityScopePicker'
import { TaskResourceBindings } from './TaskResourceBindings'
import { sourceChoice, sourceChoiceKey } from './task-capability-scope-selection'

export function NativeTaskCapabilityScopeSettings({ target, original, snapshot, onChanged }: { target: TaskWorkspaceTarget; original: IntegrationTaskCapabilityScopeControlTarget; snapshot: IntegrationTaskCapabilityScopeSnapshot; onChanged?: (snapshot: IntegrationTaskCapabilityScopeSnapshot) => void }) {
  const scope = usePluginTargetScope(target.serverId, target.workspacePath)
  return <OwnedSettings key={JSON.stringify([scope.key, target, original])} target={target} original={original} snapshot={snapshot} current={scope.isCurrent} onChanged={onChanged} />
}
function OwnedSettings({ target, original, snapshot, current, onChanged }: { target: TaskWorkspaceTarget; original: IntegrationTaskCapabilityScopeControlTarget; snapshot: IntegrationTaskCapabilityScopeSnapshot; current: () => boolean; onChanged?: (snapshot: IntegrationTaskCapabilityScopeSnapshot) => void }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh')
  const [client] = useState(() => createTaskCapabilityScopeSettingsTransport(target, original, current))
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [page, setPage] = useState<IntegrationTaskCapabilitySourceChoicesPage>(), [descriptors, setDescriptors] = useState<IntegrationTaskCapabilitySourceDescriptor[]>([])
  const [live, setLive] = useState(snapshot), [notice, setNotice] = useState(''), [unconfirmed, setUnconfirmed] = useState(false)
  const [observations, setObservations] = useState<Record<string, TaskCapabilitySourceObservation>>({})
  const generation = useRef(0), pending = useRef<AbortController | null>(null), active = useRef(false)
  useEffect(() => { const lifetime = active, sequence = generation, read = pending; lifetime.current = true; return () => { lifetime.current = false; sequence.current++; read.current?.abort(); client.dispose() } }, [client])
  const visibleSnapshot = snapshot.revision > live.revision ? snapshot : live
  const load = async (more = false) => {
    const request = ++generation.current; pending.current?.abort(); const cancel = new AbortController(); pending.current = cancel; setBusy(true); setNotice(''); setObservations({})
    try {
      const [catalog, value] = await Promise.all([client.choices(more ? page?.nextCursor ?? undefined : undefined, more ? page?.catalogRevision : undefined, cancel.signal), client.read(cancel.signal)])
      if (!active.current || !current() || request !== generation.current) return
      setPage(catalog); setLive(old => value.revision >= old.revision ? value : old); setUnconfirmed(client.hasPending()); setDescriptors(old => { const combined = more ? [...old, ...catalog.items] : catalog.items; return [...new Map(combined.map(item => [sourceChoiceKey(sourceChoice(item)), item])).values()] })
      const observed = await client.observations(more ? [...descriptors, ...catalog.items] : catalog.items, cancel.signal).catch(() => ({}))
      if (active.current && current() && request === generation.current) setObservations(observed)
    } catch { if (active.current && current() && request === generation.current) { setPage(undefined); setNotice(zh ? '当前工具提供方目录无法确认，范围设置保持只读。' : 'The current tool provider catalog is unconfirmed. Scope settings remain read-only.') } }
    finally { if (active.current && request === generation.current) setBusy(false) }
  }
  const reconcile = async () => {
    setBusy(true); try { const value = await client.reconcile(); if (active.current && current() && value) { setLive(old => value.revision >= old.revision ? value : old); onChanged?.(value); setUnconfirmed(false); setNotice('') } }
    catch { if (active.current && current()) setNotice(zh ? '原保存结果仍未确认，请继续核对原操作。' : 'The original save remains unconfirmed. Reconcile that operation.') }
    finally { if (active.current) setBusy(false) }
  }
  return <section className="space-y-3" data-testid="native-task-capability-scope-settings">
    <Button type="button" variant="outline" disabled={busy} onClick={() => { setOpen(true); void load() }}>{zh ? '设置任务工具与资源范围' : 'Set task tools and resource scope'}</Button>
    {open && <div className="space-y-3">
      {notice && <p role="status" className="text-sm text-text-secondary">{notice}</p>}
      <TaskCapabilityScopePicker snapshot={visibleSnapshot} ownerKey={JSON.stringify([target, original])} descriptors={descriptors} observations={observations} catalogState={!page || page.catalogState !== 'observed' ? 'unknown' : page.nextCursor ? 'truncated' : 'observed'} readOnly={!page || page.catalogState !== 'observed' || unconfirmed} onCommit={page?.catalogState === 'observed' && !unconfirmed ? async value => {
        try { const changed = await client.set(value.selection, value.expectedRevision); if (active.current && current()) { setLive(old => changed.revision >= old.revision ? changed : old); onChanged?.(changed); setUnconfirmed(false) } }
        catch (error) { if (active.current && current()) setUnconfirmed(true); throw error }
      } : undefined} />
      <TaskResourceBindings snapshot={visibleSnapshot} load={client.resourceChoices} readOnly={!page || page.catalogState !== 'observed' || unconfirmed || visibleSnapshot.effectiveFrom !== 'current_snapshot'} save={async bindings => {
        try { const changed = await client.setResources(visibleSnapshot.selection, bindings, visibleSnapshot.revision); if (active.current && current()) { setLive(old => changed.revision >= old.revision ? changed : old); onChanged?.(changed); setUnconfirmed(false) } }
        catch (error) { if (active.current && current()) setUnconfirmed(true); throw error }
      }} />
      <div className="flex flex-wrap gap-2">{page?.nextCursor && <Button type="button" variant="outline" disabled={busy} onClick={() => void load(true)}>{zh ? '读取更多工具提供方' : 'Load more tool providers'}</Button>}{unconfirmed && <Button type="button" variant="outline" disabled={busy} onClick={() => void reconcile()}>{zh ? '核对原保存' : 'Reconcile original save'}</Button>}<Button type="button" variant="ghost" onClick={() => { pending.current?.abort(); generation.current++; setOpen(false); setBusy(false) }}>{zh ? '关闭设置' : 'Close settings'}</Button></div>
    </div>}
  </section>
}
