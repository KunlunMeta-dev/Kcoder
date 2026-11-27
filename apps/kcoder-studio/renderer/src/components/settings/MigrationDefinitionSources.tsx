import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import { getRuntimeConfig } from '@/config/runtime'
import { DefinitionSourcesController } from '../../../../shared/migrationDefinitionSources'
export function MigrationDefinitionSources({ deviceId, workspacePath, isCurrent, onOpenBatch, onBusy }: {
  deviceId: string; workspacePath?: string; isCurrent(): boolean; onOpenBatch(id: string): void; onBusy(busy: boolean): void
}) {
  const { t } = useTranslation('migrationDefinitions')
  const model = useMemo(() => {
    const api = createMigrationApi(deviceId, workspacePath), mount = getRuntimeConfig().appBasePath
    return new DefinitionSourcesController({ definitionsDiscover: api.definitionsDiscover, scan: async ids => (await api.scanBatch({ sourceIds: ids })).job.jobId }, () => isCurrent() && mount === getRuntimeConfig().appBasePath)
  }, [deviceId, workspacePath, isCurrent])
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot)
  useEffect(() => { model.activate(); return model.dispose }, [model])
  useEffect(() => { onBusy(state.busy); return () => onBusy(false) }, [state.busy, onBusy])
  return <section className="mt-4 space-y-3" aria-busy={state.busy} data-testid="migration-definition-sources">
    <h3 className="text-base font-medium">{t('title')}</h3><p className="text-sm leading-6 text-text-secondary">{t('boundary')}</p>
    <div className="flex gap-2">{(['claude-code', 'codex'] as const).map(kind => <Button key={kind} size="sm" disabled={state.busy || state.scanUnknown} aria-pressed={kind === state.kind} variant={kind === state.kind ? 'secondary' : 'outline'} onClick={() => model.configure(kind, state.includeProject)}>{kind === 'codex' ? 'Codex' : 'Claude Code'}</Button>)}</div>
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={state.includeProject} disabled={state.busy || state.scanUnknown || !workspacePath} onChange={event => model.configure(state.kind, event.target.checked)}/>{t('includeProject')}</label>
    <Button data-testid="definition-discover" size="sm" disabled={state.busy || state.scanUnknown} onClick={() => void model.discover()}>{t('discover')}</Button>
    {state.error && <p role="alert" className="text-sm text-destructive">{t(state.error)}</p>}
    {state.page && <>
      {!state.page.sources.length && <p className="text-sm text-text-secondary">{t('noSources')}</p>}
      <div className="studio-card divide-y divide-border rounded-lg border border-border">{state.page.sources.map(row => <label key={row.sourceId} data-testid="definition-source-row" className="flex min-h-11 gap-3 px-3 py-3 text-sm"><input type="checkbox" checked={state.selected.some(value => value.sourceId === row.sourceId)} disabled={state.busy || state.scanUnknown} onChange={() => model.select(row.sourceId)}/><span><span className="block">{row.displayName} · {row.availableCategories.map(kind => t(kind)).join(' · ')}</span><span className="text-xs text-text-secondary">{t('pending')}</span></span></label>)}</div>
      <div className="flex items-center justify-between"><Button size="sm" variant="ghost" disabled={state.busy || state.scanUnknown || !state.index} onClick={() => void model.page(state.index - 1)}>{t('previous')}</Button><span className="text-xs text-text-secondary">{state.index + 1}</span><Button size="sm" variant="ghost" disabled={state.busy || state.scanUnknown || state.page.nextPage == null} onClick={() => void model.page(state.page!.nextPage!)}>{t('next')}</Button></div>
      {!!state.page.problems.length && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={state.partial} disabled={state.busy || state.scanUnknown} onChange={event => model.consent(event.target.checked)}/>{t('partial')}</label>}
      <p className="text-xs text-text-secondary">{t('selected', { count: state.selected.length })}</p>
      <Button data-testid="definition-prepare" size="sm" disabled={state.busy || state.scanUnknown || !state.selected.length || !!state.page.problems.length && !state.partial} onClick={() => void model.prepare().then(id => { if (id && model.current()) onOpenBatch(id) })}>{t('prepare')}</Button>
    </>}
  </section>
}
