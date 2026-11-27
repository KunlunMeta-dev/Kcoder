import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useMigrationDefinitionSourceDiscovery } from '@/kcoder/useMigrationDefinitionSourceDiscovery'
import { useMigrationSourceTransfer } from '@/kcoder/useMigrationSourceTransfer'
import { createMigrationSourceDirectoryIntent, emptySourceDirectoryChoice, sourceDirectoryArgument, sourceDirectoryChoiceReady } from '@/kcoder/migrationSourceDirectoryIntent'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { MigrationSourceKind } from '../../../../shared/generated/contracts'
import { MigrationSourceDirectoryChoice } from './MigrationSourceDirectoryChoice'
import { MigrationSourceTransferStatus } from './MigrationSourceTransferStatus'
import { MigrationSourceAdoptionPanel } from './MigrationSourceAdoptionPanel'

export function MigrationDefinitionSourceBrowser({ source, destination, isCurrent, onBusy, onOpenBatch, root, fixedKind }: {
  source: GatewayServer; destination: GatewayServer; isCurrent: () => boolean; onBusy: (busy: boolean) => void
  onOpenBatch?: (jobId: string) => void; root?: Parameters<typeof createMigrationSourceDirectoryIntent>[1]; fixedKind?: MigrationSourceKind
}) {
  const { t } = useTranslation('migration')
  const [kind, setKind] = useState<MigrationSourceKind>(fixedKind ?? 'claude-code')
  const [includeProject, setIncludeProject] = useState(false)
  const [directory, setDirectory] = useState(emptySourceDirectoryChoice)
  const [consentCatalog, setConsentCatalog] = useState<string | null>(null)
  const model = useMigrationDefinitionSourceDiscovery(source.id, source.workspacePath, isCurrent)
  const transfer = useMigrationSourceTransfer(destination, isCurrent)
  const [adoptionBusy, setAdoptionBusy] = useState(false), resolving = useRef(false)
  const busy = model.busy || transfer.busy || adoptionBusy
  const selected = new Set(model.selected.map(item => item.sourceId))
  const partial = !!model.page?.problems.length && consentCatalog !== model.page.catalogId
  const login = source.security?.identity.mode === 'kcoder-account' && !source.accountIdentity
    || destination.security?.identity.mode === 'kcoder-account' && !destination.accountIdentity
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  const start = async () => {
    if (!isCurrent() || !model.session || resolving.current || partial) return
    resolving.current = true
    try { const selections = await model.selections(); if (isCurrent()) await transfer.start(model.session, selections) }
    catch { /* Keep the original source child and transfer identity; no implicit rediscovery. */ }
    finally { resolving.current = false }
  }
  const scopes: Record<string, string> = {
    'user-agents': 'user', 'user-hooks': 'user', 'user-inline-hooks': 'user',
    'project-agents': 'project', 'project-hooks': 'project', 'project-inline-hooks': 'project', 'project-local-inline-hooks': 'project',
  }
  return <section data-testid="migration-definition-source-browser" className="space-y-3" aria-busy={busy}>
    <p className="text-sm leading-6 text-text-secondary">{t('definitionSource.boundary')}</p>
    <div className="flex flex-wrap gap-2">{(['claude-code', 'codex'] as const).map(value => <Button key={value} size="sm" variant={(fixedKind ?? kind) === value ? 'secondary' : 'ghost'} aria-pressed={(fixedKind ?? kind) === value} disabled={busy || !!fixedKind || !!model.session} onClick={() => setKind(value)}>{value === 'codex' ? 'Codex' : 'Claude Code'}</Button>)}</div>
    {!root && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={includeProject} disabled={busy || !!model.session} onChange={event => setIncludeProject(event.target.checked)}/>{t('project')}</label>}
    {root === undefined && <MigrationSourceDirectoryChoice value={directory} onChange={setDirectory} disabled={busy}/>}
    {login && <p role="alert" className="text-sm text-text-secondary">{t('transferBrowser.login')}</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={busy || login || model.releasePending || root === undefined && !sourceDirectoryChoiceReady(directory)} onClick={() => void model.discover(fixedKind ?? kind, root ? false : includeProject, root ?? sourceDirectoryArgument(directory))}>{t('find')}</Button>
      {model.session && <Button variant="ghost" disabled={busy} onClick={() => void model.close()}>{t('transferBrowser.disconnect')}</Button>}
    </div>
    {model.error && <p role="alert" className="text-sm text-destructive">{t(model.error.endsWith('update_required') ? 'definitionSource.updateRequired' : 'definitionSource.failed')}</p>}
    {model.releasePending && <p role="status" className="text-sm text-text-secondary">{t('transferBrowser.releasePending')}</p>}
    {model.page && <>
      {!model.page.sources.length && <p className="text-sm text-text-secondary">{t('definitionSource.empty')}</p>}
      <ul className="divide-y divide-border">{model.page.sources.map(item => <li key={item.sourceId} className="space-y-1 py-3 text-sm" data-testid="migration-definition-source-row">
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" aria-label={`${item.displayName} ${t(`definitionSource.scope.${scopes[item.scope] ?? 'unknown'}`)}`} checked={selected.has(item.sourceId)} disabled={busy || !!transfer.requestId || !selected.has(item.sourceId) && selected.size >= 64} onChange={event => model.select(item.sourceId, event.target.checked)}/><span className="break-words">{item.displayName}</span></label>
        <p className="text-xs text-text-secondary">{t(`definitionSource.scope.${scopes[item.scope] ?? 'unknown'}`)} · {item.availableCategories.map(category => t(`definitionSource.${category === 'agent' ? 'agent' : 'hook'}`)).join(' / ')}</p>
      </li>)}</ul>
      {!!model.page.problems.length && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={!partial} disabled={busy || !!transfer.requestId} onChange={event => setConsentCatalog(event.target.checked ? model.page!.catalogId : null)}/>{t('definitionSource.partial')}</label>}
      <div className="flex items-center justify-between"><Button size="sm" variant="ghost" disabled={busy || !!transfer.requestId || model.pageIndex === 0} onClick={() => void model.changePage('previous')}>{t('transferHistory.previous')}</Button><span className="text-xs text-text-secondary">{t('definitionSource.page', { page: model.pageIndex + 1 })}</span><Button size="sm" variant="ghost" disabled={busy || !!transfer.requestId || model.page.nextPage == null} onClick={() => void model.changePage('next')}>{t('transferHistory.next')}</Button></div>
      {!transfer.requestId && <Button disabled={busy || login || !selected.size || partial} onClick={() => void start()}>{t('transferBrowser.transfer', { count: selected.size })}</Button>}
    </>}
    <MigrationSourceTransferStatus model={transfer}/>
    {transfer.result?.result?.phase === 'ready' && transfer.result.result.receipt && <MigrationSourceAdoptionPanel target={destination} receipt={transfer.result.result.receipt} isCurrent={isCurrent} onBusy={setAdoptionBusy} onOpenBatch={onOpenBatch}/>}
  </section>
}
