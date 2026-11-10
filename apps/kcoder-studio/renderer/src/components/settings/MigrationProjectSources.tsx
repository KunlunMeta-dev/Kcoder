import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import { getRuntimeConfig } from '@/config/runtime'
import { ProjectSourcesController } from '../../../../shared/migrationProjectSources'
export function MigrationProjectSources({ deviceId, workspacePath, isCurrent, onOpenBatch, onBusy }: {
  deviceId: string; workspacePath?: string; isCurrent(): boolean; onOpenBatch(id: string): void; onBusy(busy: boolean): void
}) {
  const { t } = useTranslation('migrationProjects')
  const model = useMemo(() => {
    const api = createMigrationApi(deviceId, workspacePath), mount = getRuntimeConfig().appBasePath
    return new ProjectSourcesController({ discover: source => api.projectsDiscover({ source }), page: (catalogId, pageIndex) => api.projectsSources({ catalogId, pageIndex }),
      prepare: async projectSources => (await api.scanBatch({ sourceIds: [], projectSources })).job.jobId }, () => isCurrent() && mount === getRuntimeConfig().appBasePath)
  }, [deviceId, workspacePath, isCurrent])
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot)
  useEffect(() => { model.activate(); return model.dispose }, [model])
  useEffect(() => { onBusy(state.busy); return () => onBusy(false) }, [state.busy, onBusy])
  return <section className="mt-4 space-y-3" data-testid="migration-project-sources" aria-busy={state.busy}>
    <p className="text-sm leading-6 text-text-secondary">{t('boundary')}</p>
    <div className="flex gap-2">{(['claude-code','codex'] as const).map(kind => <Button key={kind} size="sm" variant={state.kind === kind ? 'secondary' : 'ghost'} disabled={state.busy || state.unknown} onClick={() => model.configure(kind)}>{kind === 'codex' ? 'Codex' : 'Claude Code'}</Button>)}</div>
    <Button size="sm" data-testid="migration-project-discover" disabled={state.busy || state.unknown} onClick={() => void model.discover()}>{t('discover')}</Button>
    {state.error && <p role="alert" className="text-sm text-destructive">{t(state.error)}</p>}
    {state.page && <>
      {!state.page.items.length && <p className="text-sm text-text-secondary">{t('noSources')}</p>}
      {state.page.items.map(row => <label key={row.sourceHandle} data-testid="migration-project-source-row" className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={state.selected.some(value => value.sourceHandle === row.sourceHandle)} disabled={state.busy || state.unknown} onChange={() => model.select(row.sourceHandle)}/><span className="min-w-0 break-all">{row.displayName} · {t('roots',{count:row.roots})}</span></label>)}
      <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={state.busy || state.unknown || !state.page.pageIndex} onClick={() => void model.page(state.page!.pageIndex - 1)}>{t('previous')}</Button><Button size="sm" variant="ghost" disabled={state.busy || state.unknown || state.page.nextPage == null} onClick={() => void model.page(state.page!.nextPage!)}>{t('next')}</Button></div>
      {(!state.page.knownRowsComplete || state.page.problems.length > 0) && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" disabled={state.busy || state.unknown} checked={state.partial} onChange={event => model.consent(event.target.checked)}/>{t('partial')}</label>}
      <p className="text-xs text-text-secondary">{t('selected',{count:state.selected.length})}</p>
      <Button size="sm" data-testid="migration-project-prepare" disabled={state.busy || state.unknown || !state.selected.length || (!state.page.knownRowsComplete || state.page.problems.length > 0) && !state.partial} onClick={() => void model.prepare().then(id => { if (id && model.current()) onOpenBatch(id) })}>{t('prepare')}</Button>
    </>}
  </section>
}
