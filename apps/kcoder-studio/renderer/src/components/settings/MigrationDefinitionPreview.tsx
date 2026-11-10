import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import { getRuntimeConfig } from '@/config/runtime'
import { DefinitionPreviewController } from '../../../../shared/migrationDefinitionPreview'
export function MigrationDefinitionPreview({ deviceId, workspacePath, jobId, itemId, isCurrent }: { deviceId: string; workspacePath?: string; jobId: string; itemId: string; isCurrent(): boolean }) {
  const { t } = useTranslation('migrationDefinitions')
  const model = useMemo(() => { const mount = getRuntimeConfig().appBasePath; return new DefinitionPreviewController(createMigrationApi(deviceId, workspacePath), { jobId, itemId }, () => isCurrent() && mount === getRuntimeConfig().appBasePath) }, [deviceId, workspacePath, jobId, itemId, isCurrent])
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot), report = state.report
  useEffect(() => { model.activate(); return model.dispose }, [model])
  return <section className="studio-card-spacing mt-3 space-y-3 rounded-lg border border-border" data-testid="migration-definition-preview" aria-busy={state.busy}>
    <p className="text-sm leading-6 text-text-secondary">{t('pending')} · {t('review')}</p>
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" data-testid="definition-report" disabled={state.busy} onClick={() => void model.report()}>{t('report')}</Button><Button size="sm" variant="ghost" data-testid="definition-body" disabled={state.busy} onClick={() => void model.body()}>{t('readBody')}</Button></div>
    {state.error && <p role="alert" className="text-sm text-destructive">{t(state.error)}</p>}
    {report && <div data-testid="definition-field-report" className="space-y-2"><p className="text-xs text-text-secondary">{t(report.report.parseStatus)} · {t('reportPage', { count: report.totalFields, bytes: report.totalBytes })}</p>{report.report.fields.map(row => <div key={`${row.element}:${row.ordinal}`} data-testid="definition-field" className="text-sm"><span>{row.field ? t(`fields.${row.field}`) : t('unknownField', { ordinal: row.ordinal + 1 })}</span><span className="ml-2 text-xs text-text-secondary">{t('element', { element: row.element + 1 })}</span></div>)}<div className="flex justify-between"><Button size="sm" variant="ghost" disabled={state.busy || !report.pageIndex} onClick={() => void model.report(report.pageIndex - 1)}>{t('previous')}</Button><Button size="sm" variant="ghost" disabled={state.busy || report.nextPage == null} onClick={() => void model.report(report.nextPage!)}>{t('next')}</Button></div></div>}
    {state.body && <div data-testid="definition-body-window" className="space-y-2"><p className="text-xs leading-5 text-text-secondary">{t('bodyBoundary')}</p><p className="text-xs text-text-secondary">{t('bodyBytes', { offset: state.body.offset, end: state.body.nextOffset ?? state.body.totalBytes, total: state.body.totalBytes })}</p>{state.body.encoding === 'utf8' ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-3 text-sm">{state.body.text}</pre> : <p className="text-sm text-text-secondary">{t('binary')}</p>}<div className="flex justify-between"><Button size="sm" variant="ghost" disabled={state.busy || state.offsets.length < 2} onClick={() => void model.previous()}>{t('previous')}</Button><Button size="sm" variant="ghost" disabled={state.busy || state.body.nextOffset == null} onClick={() => void model.next()}>{t('next')}</Button></div></div>}
  </section>
}
