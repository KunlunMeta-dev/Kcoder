import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useMigrationMemorySourceDiscovery } from '@/kcoder/useMigrationMemorySourceDiscovery'
import { useMigrationSourceTransfer } from '@/kcoder/useMigrationSourceTransfer'
import { createMigrationSourceDirectoryIntent, emptySourceDirectoryChoice, sourceDirectoryArgument, sourceDirectoryChoiceReady } from '@/kcoder/migrationSourceDirectoryIntent'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { MigrationSourceKind } from '../../../../shared/generated/contracts'
import { MigrationSourceDirectoryChoice } from './MigrationSourceDirectoryChoice'
import { MigrationSourceTransferStatus } from './MigrationSourceTransferStatus'
import { MigrationSourceAdoptionPanel } from './MigrationSourceAdoptionPanel'

export function MigrationMemorySourceBrowser({ source, destination, isCurrent, onBusy, onOpenBatch, root, fixedKind }: {
  source: GatewayServer; destination: GatewayServer; isCurrent: () => boolean; onBusy: (busy: boolean) => void;
  onOpenBatch?: (jobId: string) => void; root?: Parameters<typeof createMigrationSourceDirectoryIntent>[1]; fixedKind?: MigrationSourceKind
}) {
  const { t } = useTranslation('migrationMemory'), { t: migrationText } = useTranslation('migration')
  const [kind, setKind] = useState<MigrationSourceKind>(fixedKind ?? 'claude-code')
  const [directory, setDirectory] = useState(emptySourceDirectoryChoice)
  const model = useMigrationMemorySourceDiscovery(source.id, source.workspacePath, isCurrent)
  const transfer = useMigrationSourceTransfer(destination, isCurrent)
  const [adoptionBusy, setAdoptionBusy] = useState(false), resolving = useRef(false)
  const busy = model.busy || transfer.busy || adoptionBusy
  const selected = new Set(model.selected.map(item => item.sourceId))
  const login = source.security?.identity.mode === 'kcoder-account' && !source.accountIdentity
    || destination.security?.identity.mode === 'kcoder-account' && !destination.accountIdentity
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  const start = async () => {
    if (!isCurrent() || !model.session || resolving.current) return
    resolving.current = true
    try { const selections = await model.selections(); if (isCurrent()) await transfer.start(model.session, selections) }
    catch { /* The owned catalog reports failures; no source is reconstructed from a path. */ }
    finally { resolving.current = false }
  }
  return <section data-testid="migration-memory-source-browser" className="space-y-3" aria-busy={busy}>
    <p className="text-sm leading-6 text-text-secondary">{t('sourceBoundary')}</p>
    <div className="flex gap-2">{(['claude-code', 'codex'] as const).map(value => <Button key={value} size="sm" variant={(fixedKind ?? kind) === value ? 'secondary' : 'ghost'} aria-pressed={(fixedKind ?? kind) === value} disabled={busy || !!fixedKind || !!model.session} onClick={() => setKind(value)}>{value === 'codex' ? 'Codex' : 'Claude Code'}</Button>)}</div>
    {root === undefined && <MigrationSourceDirectoryChoice value={directory} onChange={setDirectory} disabled={busy}/>}
    {login && <p role="alert" className="text-sm text-text-secondary">{migrationText('transferBrowser.login')}</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={busy || login || model.releasePending || root === undefined && !sourceDirectoryChoiceReady(directory)} onClick={() => void model.discover(fixedKind ?? kind, root ?? sourceDirectoryArgument(directory))}>{t('discover')}</Button>
      {model.session && <Button variant="ghost" disabled={busy} onClick={() => void model.close()}>{migrationText('transferBrowser.disconnect')}</Button>}
    </div>
    {model.error && <p role="alert" className="text-sm text-destructive">{t('errors.sourceFailed')}</p>}
    {model.releasePending && <p role="status" className="text-sm text-text-secondary">{migrationText('transferBrowser.releasePending')}</p>}
    {model.page && <>
      {!model.page.items.length && <p className="text-sm text-text-secondary">{t('noSources')}</p>}
      <ul className="divide-y divide-border">{model.page.items.map(item => <li key={item.sourceId} className="space-y-1 py-3 text-sm" data-testid="migration-memory-source-row">
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" aria-label={item.sourceGroup} checked={selected.has(item.sourceId)} disabled={busy || !!transfer.requestId || !item.files || !selected.has(item.sourceId) && selected.size >= 64} onChange={event => model.select(item.sourceId, event.target.checked)}/><span className="break-all">{item.sourceGroup}</span></label>
        <p className="text-xs text-text-secondary">{t(`layouts.${item.layout}`)} · {t('sourceSize', { files: item.files, bytes: item.bytes })}</p>
        {item.blockedItems > 0 && <p className="text-xs text-text-secondary">{t('sourceBlocked', { count: item.blockedItems })}</p>}
      </li>)}</ul>
      <div className="flex items-center justify-between"><Button size="sm" variant="ghost" disabled={busy || !!transfer.requestId || model.pageIndex === 0} onClick={() => void model.changePage('previous')}>{t('previous')}</Button><span className="text-xs text-text-secondary">{t('page', { page: model.pageIndex + 1 })}</span><Button size="sm" variant="ghost" disabled={busy || !!transfer.requestId || !model.page.nextCursor} onClick={() => void model.changePage('next')}>{t('next')}</Button></div>
      {!transfer.requestId && <Button disabled={busy || login || !selected.size} onClick={() => void start()}>{migrationText('transferBrowser.transfer', { count: selected.size })}</Button>}
    </>}
    <MigrationSourceTransferStatus model={transfer}/>
    {transfer.result?.result?.phase === 'ready' && transfer.result.result.receipt && <MigrationSourceAdoptionPanel target={destination} receipt={transfer.result.result.receipt} isCurrent={isCurrent} onBusy={setAdoptionBusy} onOpenBatch={onOpenBatch}/>}
  </section>
}
