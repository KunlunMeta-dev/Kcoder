import { MigrationHistoryGroups } from './MigrationHistoryGroup'
import { MigrationHistoryFamilyChoice } from './MigrationHistoryFamilyChoice'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useMigrationHistorySourceDiscovery } from '@/kcoder/useMigrationHistorySourceDiscovery'
import { useMigrationSourceTransfer } from '@/kcoder/useMigrationSourceTransfer'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { MigrationSourceKind, SourceUploadState } from '../../../../shared/generated/contracts'
import { MigrationSourceTransferStatus } from './MigrationSourceTransferStatus'
import { MigrationSourceAdoptionPanel } from './MigrationSourceAdoptionPanel'
import { MigrationSourceDirectoryChoice } from './MigrationSourceDirectoryChoice'
import { emptySourceDirectoryChoice, sourceDirectoryChoiceReady, sourceDirectoryArgument } from '@/kcoder/migrationSourceDirectoryIntent'

type Props = { source: GatewayServer; destination: GatewayServer; isCurrent: () => boolean; onBusy: (busy: boolean) => void; onOpenBatch?: (jobId: string) => void; uploaded?: SourceUploadState }
export function MigrationHistorySourceBrowser(props: Props) {
  const [kind, setKind] = useState<MigrationSourceKind>('claude-code')
  const [busy, setBusy] = useState(false)
  return <div className="space-y-3" data-testid="migration-history-source-browser">
    <div className="flex gap-2">{(['claude-code', 'codex'] as const).map(value => <Button key={value} size="sm"
      variant={(props.uploaded?.source ?? kind) === value ? 'secondary' : 'ghost'} aria-pressed={(props.uploaded?.source ?? kind) === value} disabled={busy || !!props.uploaded}
      onClick={() => setKind(value)}>{value === 'codex' ? 'Codex' : 'Claude Code'}</Button>)}</div>
    <HistoryContents key={kind} {...props} kind={kind} onWorking={setBusy}/>
  </div>
}

function HistoryContents({ source, destination, isCurrent, onBusy, kind, onWorking, onOpenBatch, uploaded }: Props & { kind: MigrationSourceKind; onWorking: (busy: boolean) => void }) {
  const { t } = useTranslation('migration')
  const model = useMigrationHistorySourceDiscovery(source.id, source.workspacePath, isCurrent)
  const [directory, setDirectory] = useState(emptySourceDirectoryChoice)
  const [transferBusy, setTransferBusy] = useState(false)
  const busy = model.busy || transferBusy
  useEffect(() => { onBusy(busy); onWorking(busy); return () => { onBusy(false); onWorking(false) } }, [busy, onBusy, onWorking])
  const sourceLogin = source.security?.identity.mode === 'kcoder-account' && !source.accountIdentity
  return <div className="space-y-3" aria-busy={busy}>
    <p className="text-sm text-text-secondary">{t('transferHistory.boundary')}</p>
    {!uploaded && <MigrationSourceDirectoryChoice value={directory} onChange={setDirectory} disabled={busy}/>}
    {sourceLogin && <p role="alert" className="text-sm text-text-secondary">{t('transferBrowser.login')}</p>}
    <div className="flex gap-2">
      <Button data-testid="migration-history-source-discover" disabled={busy || sourceLogin || model.releasePending || !uploaded && !sourceDirectoryChoiceReady(directory)} onClick={() => void model.discover(uploaded?.source ?? kind, uploaded ? { operationId: uploaded.operationId, manifestSha256: uploaded.manifestSha256 } : sourceDirectoryArgument(directory))}>{t(model.familyMode ? 'historyFamilies.basic' : 'transferHistory.discover')}</Button>
      {model.session && <Button variant="ghost" disabled={busy} onClick={() => void model.close()}>{t('transferBrowser.disconnect')}</Button>}
    </div>
    {(uploaded?.source ?? kind) === 'codex' && <MigrationHistoryFamilyChoice disabled={busy || sourceLogin || model.releasePending || !uploaded && !sourceDirectoryChoiceReady(directory)} active={model.familyMode}
      onDiscover={() => void model.discover('codex', uploaded ? { operationId: uploaded.operationId, manifestSha256: uploaded.manifestSha256 } : sourceDirectoryArgument(directory), true)}/>}
    {model.error && <p role="alert" className="text-sm text-destructive">{t(model.familyMode && (model.error.endsWith('update_required') || model.error === 'source_transfer_unsupported_native') ? 'historyFamilies.updateRequired' : model.error.startsWith('source_transfer_directory_') ? (model.error.endsWith('update_required') ? 'sourceDirectory.updateRequired' : 'sourceDirectory.failed') : 'transferHistory.catalogUnavailable')}</p>}
    {model.releasePending && <p role="status" className="text-sm text-text-secondary">{t('transferBrowser.releasePending')}</p>}
    {model.session && <HistorySelection key={model.session.sessionId} model={model} destination={destination} isCurrent={isCurrent} onBusy={setTransferBusy} onOpenBatch={onOpenBatch}/>}
  </div>
}

function HistorySelection({ model, destination, isCurrent, onBusy, onOpenBatch }: {
  model: ReturnType<typeof useMigrationHistorySourceDiscovery>; destination: GatewayServer; isCurrent: () => boolean; onBusy: (value: boolean) => void; onOpenBatch?: (jobId: string) => void
}) {
  const { t } = useTranslation('migration')
  const transfer = useMigrationSourceTransfer(destination, isCurrent), resolving = useRef(false)
  const [adoptionBusy, setAdoptionBusy] = useState(false)
  const busy = model.busy || transfer.busy || adoptionBusy
  const targetLogin = destination.security?.identity.mode === 'kcoder-account' && !destination.accountIdentity
  const selected = new Set(model.selected.map(item => item.sourceHandle))
  useEffect(() => { onBusy(transfer.busy || adoptionBusy); return () => onBusy(false) }, [transfer.busy, adoptionBusy, onBusy])
  async function start() {
    if (resolving.current || !model.session || !isCurrent()) return
    resolving.current = true
    try { await transfer.start(model.session, model.selections()) } catch {
      // Invalid/expired catalogs are never reconstructed from a historical path.
    } finally { resolving.current = false }
  }
  return <div className="space-y-3">
    {model.page && <>
      <p className="text-sm text-text-secondary">{t('transferHistory.found', { count: model.page.totalItems })}</p>
      {(!model.page.discoveryComplete || model.page.problems.length > 0) && <p role="status" className="text-sm text-text-secondary">{t('transferHistory.partialDiscovery')}</p>}
      {model.familyMode && model.page.problems.filter(problem => problem.code.startsWith('history_discovery_family_')).map(problem => <p key={problem.code} role="status" className="text-sm text-text-secondary">{t(`historyFamilies.problems.${problem.code}`, { count: problem.count, defaultValue: t('historyFamilies.incomplete') })}</p>)}
      <MigrationHistoryGroups items={model.page.items} groups={model.familyGroups}>{item => <div key={item.sourceHandle} className="space-y-1 py-3 text-sm" data-testid="migration-history-source-row">
        <label className="flex min-h-11 items-start gap-2">
          <input type="checkbox" className="mt-1" aria-label={item.title || item.sourceSessionId} checked={selected.has(item.sourceHandle)}
            disabled={busy || !!transfer.requestId || item.importIssues.length > 0 || !selected.has(item.sourceHandle) && model.selected.length >= 64}
            onChange={event => model.select(item.sourceHandle, event.target.checked)}/>
          <span className="min-w-0 break-words">{item.title || item.sourceSessionId}</span>
        </label>
        <p className="text-text-secondary">{t('transferHistory.originalBytes', { count: item.bytes })}{item.archived ? ` · ${t('transferHistory.archived')}` : ''}{item.compressed ? ` · ${t('transferHistory.compressed')}` : ''}</p>
        {item.previewIncomplete && <p className="text-text-secondary">{t('transferHistory.partialPreview')}</p>}
        {item.importIssues.length > 0 && <p className="text-destructive">{t('transferHistory.blocked')}</p>}
        <details><summary className="cursor-pointer text-text-secondary">{t('transferHistory.provenance')}</summary>
          <dl className="mt-2 space-y-1 break-all text-text-secondary">
            <div><dt>{t('transferHistory.session')}</dt><dd>{item.sourceSessionId}</dd></div>
            {item.sourceArtifactId && <div><dt>{t('transferHistory.artifact')}</dt><dd>{item.sourceArtifactId}</dd></div>}
            {item.parentSessionId && <div><dt>{t('transferHistory.parent')}</dt><dd>{item.parentSessionId}</dd></div>}
            {item.agentId && <div><dt>{t('transferHistory.agent')}</dt><dd>{item.agentId}</dd></div>}
            {item.project && <div><dt>{t('transferHistory.project')}</dt><dd>{item.project}</dd></div>}
          </dl>
        </details>
      </div>}</MigrationHistoryGroups>
      <div className="flex items-center justify-between gap-2 text-sm"><span>{t('page', { page: model.pageIndex + 1 })}</span><div className="flex gap-2">
        <Button size="sm" variant="ghost" data-testid="migration-history-source-previous" disabled={busy || !!transfer.requestId || model.pageIndex === 0} onClick={() => void model.changePage('previous')}>{t('previous')}</Button>
        <Button size="sm" variant="ghost" data-testid="migration-history-source-next" disabled={busy || !!transfer.requestId || !model.page.nextCursor} onClick={() => void model.changePage('next')}>{t('next')}</Button>
      </div></div>
      <p className="text-sm text-text-secondary">{t('transferHistory.selected', { count: model.selected.length })}</p>
      {targetLogin && <p role="alert" className="text-sm text-text-secondary">{t('transferBrowser.targetLogin')}</p>}
      {!transfer.requestId && <Button data-testid="migration-history-source-transfer" disabled={busy || targetLogin || !model.selected.length} onClick={() => void start()}>{t('transferBrowser.transfer', { count: model.selected.length })}</Button>}
    </>}
    <MigrationSourceTransferStatus model={transfer}/>
    {transfer.result?.result?.phase === 'ready' && transfer.result.result.receipt && <MigrationSourceAdoptionPanel target={destination}
      receipt={transfer.result.result.receipt} isCurrent={isCurrent} onBusy={setAdoptionBusy} onOpenBatch={onOpenBatch}/>}
  </div>
}
