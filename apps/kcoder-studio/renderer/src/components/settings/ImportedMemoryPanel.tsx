import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import { createMemoryManager } from '@/kcoder/migrationMemoryController'
import { migrationSourceRecoveryScope } from '@/kcoder/migrationSourceTransferScope'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { ImportedMemoryRecordSummary } from '../../../../shared/generated/contracts'

export function ImportedMemoryPanel({ target, onImport, onOpenJob }: {
  target: GatewayServer; onImport: () => void; onOpenJob: (jobId: string) => void
}) {
  const { t, i18n } = useTranslation('migrationMemory')
  const lifetime = usePluginTargetScope(target.id, target.workspacePath)
  const isCurrent = lifetime.isCurrent
  const scope = migrationSourceRecoveryScope(target)
  const manager = useMemo(() => createMemoryManager({ api: createMigrationApi(target.id, target.workspacePath),
    storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key) },
    scope, isCurrent: () => isCurrent() && scope === migrationSourceRecoveryScope(target) }), [target, scope, isCurrent])
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  const [confirmation, setConfirmation] = useState<ImportedMemoryRecordSummary | null>(null)
  useEffect(() => { manager.activate(); return () => manager.dispose() }, [manager])
  const rows = state.page?.items ?? []
  const previousReceipt = state.outcome?.receipt, observed = state.outcome?.current
  return <section data-testid="imported-memory-panel" className="studio-card-spacing mt-4 space-y-3 rounded-lg border border-border bg-background" aria-busy={state.busy}>
    <h2 className="text-sm font-semibold text-text-primary">{t('title')}</h2>
    <p className="text-sm leading-6 text-text-secondary">{t('boundary')}</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={state.busy} onClick={() => void manager.load()}>{t('load')}</Button>
      <Button size="sm" disabled={state.busy || !!state.pending} onClick={onImport}>{t('import')}</Button>
    </div>
    {state.error && <p role="alert" className="text-sm text-destructive">{t(`errors.${state.error}`)}</p>}
    {state.pending && <div className="studio-card-spacing space-y-2 rounded-md border border-border text-sm" data-testid="memory-control-recovery">
      <p>{t('pending', { id: state.pending.id })}</p>
      <Button size="sm" variant="outline" disabled={state.busy} onClick={() => void manager.check()}>{t('check')}</Button>
      {state.checked && !previousReceipt && <><p className="text-text-secondary">{t('noReceipt')}</p><Button size="sm" disabled={state.busy} onClick={() => void manager.retry()}>{t('retry')}</Button></>}
      {previousReceipt && <>
        <p data-testid="memory-control-receipt">{t(previousReceipt.request.enabled ? 'receiptEnabled' : 'receiptDisabled')}</p>
        <p data-testid="memory-control-current">{observed ? t(observed.enabled ? 'currentEnabled' : 'currentDisabled') : t('currentMissing')}</p>
        {observed && observed.revision !== previousReceipt.appliedRevision && <p>{t('changedAfter')}</p>}
        <Button size="sm" disabled={state.busy} onClick={() => { manager.acknowledge(); void manager.load(state.pageIndex) }}>{t('acknowledge')}</Button>
      </>}
    </div>}
    {state.page && !rows.length && <p className="py-3 text-sm text-text-secondary">{t('empty')}</p>}
    <div className="divide-y divide-border">{rows.map(record => <article key={record.id} className="space-y-2 py-3" data-testid="memory-record">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0"><h3 className="truncate text-sm font-medium">{record.name}</h3><p className="text-xs text-text-secondary">{t(record.scope.kind === 'project' ? 'project' : 'global')} · {t(record.enabled ? 'enabled' : 'disabled')}</p></div>
        <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={state.busy} onClick={() => void manager.read(record)}>{t('read')}</Button>
          <Button size="sm" variant="outline" disabled={state.busy || !!state.pending || state.recoveryBlocked} onClick={() => record.enabled ? void manager.control(record, false, false) : setConfirmation(record)}>{t(record.enabled ? 'disable' : 'enable')}</Button></div>
      </div>
      {confirmation?.id === record.id && <div className="studio-card-spacing space-y-2 rounded-md border border-border" role="alertdialog" aria-label={t('confirmTitle')}>
        <p className="text-sm leading-6">{t('confirm')}</p>
        <div className="flex gap-2"><Button size="sm" disabled={state.busy} onClick={() => { setConfirmation(null); void manager.control(record, true, true) }}>{t('confirmEnable')}</Button><Button size="sm" variant="ghost" onClick={() => setConfirmation(null)}>{t('cancel')}</Button></div>
      </div>}
      {record.provenance && <details className="text-xs leading-5 text-text-secondary"><summary className="cursor-pointer">{t('provenance')}</summary>
        <dl className="mt-2 grid gap-1 break-all"><div>{record.provenance.source} · {t(`layouts.${record.provenance.layout}`)}</div><div>{record.provenance.sourceGroup} / {record.provenance.sourceFile}</div><div>{record.provenance.sourceModifiedAtMs == null ? t('unknownTime') : new Date(record.provenance.sourceModifiedAtMs).toLocaleString(i18n.language)}</div><div>{t('unverified')}</div></dl>
        {record.provenance.migrationJobId && <><p className="mt-2">{t('undoBoundary')}</p><Button size="sm" variant="ghost" disabled={state.busy || !!state.pending} onClick={() => onOpenJob(record.provenance!.migrationJobId!)}>{t('openJob')}</Button></>}
      </details>}
      {state.body?.record.id === record.id && <div className="space-y-2"><pre data-testid="memory-record-body" className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface p-3 text-sm leading-6">{state.body.text}</pre>
        {state.body.nextOffset != null && <Button size="sm" variant="outline" disabled={state.busy} onClick={() => void manager.read(state.body!.record, state.body!.nextOffset!)}>{t('nextText')}</Button>}</div>}
    </article>)}</div>
    {state.page && <div className="flex items-center justify-between"><Button size="sm" variant="ghost" disabled={state.busy || state.pageIndex === 0} onClick={() => void manager.load(state.pageIndex - 1)}>{t('previous')}</Button><span className="text-xs text-text-secondary">{t('page', { page: state.pageIndex + 1 })}</span><Button size="sm" variant="ghost" disabled={state.busy || state.page.nextPage == null} onClick={() => void manager.load(state.page!.nextPage!)}>{t('next')}</Button></div>}
  </section>
}
