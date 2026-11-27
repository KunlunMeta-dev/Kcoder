import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useMigrationSourceTransfer } from '@/kcoder/useMigrationSourceTransfer'
import type { useMigrationSourceDiscovery } from '@/kcoder/useMigrationSourceDiscovery'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import { MigrationSourceTransferStatus } from './MigrationSourceTransferStatus'
import { MigrationSourceAdoptionPanel } from './MigrationSourceAdoptionPanel'
import { MigrationCodexLayerReport } from './MigrationCodexLayerReport'
import { MigrationConfigurationLayers } from './MigrationConfigurationLayers'

export function MigrationSourceTransferSelection({ source, destination, isCurrent, onBusy, onOpenBatch }: {
  source: ReturnType<typeof useMigrationSourceDiscovery>
  destination: GatewayServer
  isCurrent: () => boolean
  onBusy: (value: boolean) => void
  onOpenBatch?: (jobId: string) => void
}) {
  const { t } = useTranslation('migration')
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const resolving = useRef(false)
  const transfer = useMigrationSourceTransfer(destination, isCurrent)
  const [adoptionBusy, setAdoptionBusy] = useState(false)
  const rows = source.result?.sources ?? []
  const busy = source.busy || transfer.busy || adoptionBusy
  const loginRequired = destination.security?.identity.mode === 'kcoder-account' && !destination.accountIdentity
  useEffect(() => { onBusy(transfer.busy || adoptionBusy); return () => onBusy(false) }, [transfer.busy, adoptionBusy, onBusy])
  async function start() {
    if (resolving.current || !source.session || !isCurrent()) return
    resolving.current = true
    try {
      const bindings = await source.selections(selected)
      if (isCurrent()) await transfer.start(source.session, bindings)
    } catch {
      // The source controller reports classification/scope failures without writing the target.
    } finally { resolving.current = false }
  }
  async function derive(sourceId: string) {
    if (!isCurrent()) return
    try {
      const value = await source.deriveCodexLayers(sourceId)
      if (isCurrent()) {
        setSelected(previous => {
          const remaining = previous.filter(id => !value.replacesSourceIds.includes(id) && id !== value.source.sourceId)
          return remaining.length < 64 ? [...remaining, value.source.sourceId] : remaining
        })
        setPage(0)
      }
    } catch {
      // The owned source controller preserves failed authority checks and the old selection.
    }
  }
  return <div className="space-y-3">
    <p className="text-sm text-text-secondary">{t(rows.length ? 'found' : 'empty')}</p>
    <ul className="divide-y divide-border">{rows.slice(page * 10, page * 10 + 10).map(item => <li key={item.sourceId} className="py-2 text-sm">
      <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={selected.includes(item.sourceId)}
        disabled={busy || !!transfer.requestId || (!selected.includes(item.sourceId) && selected.length >= 64)}
        onChange={event => setSelected(previous => event.target.checked ? [...previous, item.sourceId] : previous.filter(id => id !== item.sourceId))} />
        <span>{item.kind === 'claude-code' && item.scope === 'project-effective' ? t('layers.effectiveSource') : item.displayName}</span><span className="text-text-secondary">{item.scope === 'project-effective' ? t('layers.effectiveScope') : t(item.scope === 'project' ? 'project_scope' : item.scope, { defaultValue: item.scope })}</span>
      </label>
      {!transfer.requestId && item.kind === 'codex' && item.scope === 'user' && source.canDeriveCodexLayers && <Button
        size="sm" variant="ghost" data-testid={`migration-source-codex-select-${item.sourceId}`} disabled={busy}
        onClick={() => void derive(item.sourceId)}>{t('codex_layers.merge')}</Button>}
      {item.scope === 'codex-project-layers' && <p className="text-xs text-text-secondary">{t('codex_layers.replacement')}</p>}
      {item.kind === 'claude-code' && item.scope === 'project-effective' && source.session && <MigrationConfigurationLayers deviceId={source.session.targetId}
        workspacePath={source.session.workspacePath ?? undefined} target={{ kind: 'source', sourceId: item.sourceId }} isCurrent={isCurrent} readSource={source.readConfigurationLayers}/>}
      {item.scope === 'codex-project-layers' && source.session && <MigrationCodexLayerReport deviceId={source.session.targetId}
        workspacePath={source.session.workspacePath ?? undefined} target={{ kind: 'source', sourceId: item.sourceId }} isCurrent={isCurrent} readSource={source.readCodexLayers}/>}
    </li>)}</ul>
    {!!source.result?.problems?.length && <p role="status" className="text-sm text-text-secondary">{t('transferBrowser.partial')}</p>}
    {rows.length > 10 && <div className="flex items-center justify-between gap-2 text-sm"><span>{t('page', { page: page + 1 })}</span><div className="flex gap-2">
      <Button size="sm" variant="ghost" disabled={busy || page === 0} onClick={() => setPage(value => value - 1)}>{t('previous')}</Button>
      <Button size="sm" variant="ghost" disabled={busy || (page + 1) * 10 >= rows.length} onClick={() => setPage(value => value + 1)}>{t('next')}</Button>
    </div></div>}
    {loginRequired && <p role="alert" className="text-sm text-text-secondary">{t('transferBrowser.targetLogin')}</p>}
    {!transfer.requestId && <>
      <p className="text-xs text-text-secondary">{t('transferBrowser.previewOnly')}</p>
      <Button disabled={busy || loginRequired || !selected.length} onClick={() => void start()}>{t('transferBrowser.transfer', { count: selected.length })}</Button>
    </>}
    <MigrationSourceTransferStatus model={transfer} />
    {transfer.result?.result?.phase === 'ready' && transfer.result.result.receipt && <MigrationSourceAdoptionPanel target={destination}
      receipt={transfer.result.result.receipt} isCurrent={isCurrent} onBusy={setAdoptionBusy} onOpenBatch={onOpenBatch}/>}
  </div>
}
