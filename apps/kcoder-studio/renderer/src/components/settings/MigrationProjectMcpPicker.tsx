import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { ProjectMcpCatalogController, ProjectMcpCatalogState } from '../../../../shared/migrationProjectMcp'

export function MigrationProjectMcpPicker({ controller, state, disabled = false }: { controller: ProjectMcpCatalogController; state: ProjectMcpCatalogState; disabled?: boolean }) {
  const { t } = useTranslation('migration')
  if (state.page?.status !== 'selection_required' && !state.error) return null
  const busy = state.busy || disabled
  return <section className="space-y-2 rounded-lg bg-surface p-3" aria-label={t('project_mcp.title')}>
    <p className="text-sm font-medium">{t('project_mcp.title')}</p>
    <p className="text-xs leading-5 text-text-secondary">{t('project_mcp.boundary')}</p>
    {state.error ? <p role="status" className="text-sm text-text-secondary">{t(state.error === 'migration_project_mcp_update_required' ? 'project_mcp.upgrade' : 'project_mcp.failed')}</p> : <>
      {state.page?.names.map(name => <label key={name} className="flex min-h-11 items-center gap-2 break-all text-sm">
        <input type="checkbox" disabled={busy} checked={state.selected.includes(name)} onChange={() => controller.choose(name)} />{name}
      </label>)}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-text-secondary">{t('project_mcp.selected', { count: state.selected.length, total: state.page?.totalNames ?? 0 })}</span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={busy || state.pageIndex === 0} onClick={() => void controller.load(state.pageIndex - 1)}>{t('previous')}</Button>
          <Button size="sm" variant="ghost" disabled={busy || state.page?.nextPageIndex == null} onClick={() => void controller.load(state.pageIndex + 1)}>{t('next')}</Button>
        </div>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={state.confirmed} onChange={event => controller.confirm(event.target.checked)} />{t('project_mcp.confirm')}</label>
    </>}
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void controller.load(0, true)}>{t('refresh')}</Button>
  </section>
}
