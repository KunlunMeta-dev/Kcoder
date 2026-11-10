import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import { requestLocalExecutor } from '@/host/localExecutor'
import { createRandomUuid } from '@/lib/random-id'
import { ProjectMappingController, type ProjectTargetCatalogCache } from '../../../../shared/migrationProjectMapping'
import type { MigrationBatchChoice } from '../../../../shared/generated/contracts'

export function MigrationProjectMapping({ deviceId, workspacePath, jobId, itemId, isCurrent, onSave, onCancel, readOnly = false, catalog }: {
  deviceId: string; workspacePath?: string; jobId: string; itemId: string; isCurrent(): boolean
  catalog?: ProjectTargetCatalogCache; onSave?(choice: MigrationBatchChoice): void; onCancel?(): void; readOnly?: boolean
}) {
  const { t } = useTranslation('migrationProjects')
  const model = useMemo(() => new ProjectMappingController(createMigrationApi(deviceId, workspacePath), () => true, isCurrent,
    error => error instanceof Error ? error.message : 'migration_request_failed', catalog), [deviceId, workspacePath, isCurrent, catalog])
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot)
  const [reportPage, setReportPage] = useState(0), [path, setPath] = useState(''), [name, setName] = useState('')
  const [registering, setRegistering] = useState(false), [registrationUnknown, setRegistrationUnknown] = useState(false), [registrationError, setRegistrationError] = useState(false)
  const lifecycle = useRef({ generation: 0 })
  const registration = useRef<{ key: string; name: string; path: string } | null>(null)
  useEffect(() => { const holder = lifecycle.current; holder.generation++; void model.load(jobId, itemId, !readOnly); return () => { holder.generation++; model.dispose() } }, [model, jobId, itemId, readOnly, lifecycle])
  const register = async () => {
    if (!isCurrent() || registering || registrationUnknown || !path.trim() || !name.trim() || state.error || !state.report.length) return
    const holder = lifecycle.current, owner = holder.generation
    const current = () => isCurrent() && owner === holder.generation
    const input = { key: createRandomUuid(), name: name.trim(), path: path.trim() }
    registration.current = input; setRegistering(true); setRegistrationError(false)
    try {
      const result = await requestLocalExecutor<{ accepted: boolean; projectKey: string }>('runtime.projects.upsert_local', {
        deviceId, runtime: 'kcoder', preserveExisting: true, projectKey: input.key, name: input.name, roots: [input.path],
      })
      if (!current() || registration.current !== input) return
      if (!result.accepted || result.projectKey !== input.key) throw new Error('not-confirmed')
      registration.current = null; setPath(''); setName(''); catalog?.reset(); await model.load(jobId, itemId)
    } catch (error) { if (current()) { setRegistrationError(true); setRegistrationUnknown(!(error instanceof Error && error.message.includes('workspace_project_already_registered'))) } }
    finally { if (current()) setRegistering(false) }
  }
  return <section className="space-y-3" data-testid="migration-project-mapping" aria-busy={state.busy || registering}>
    <p className="text-sm leading-6 text-text-secondary">{t('boundary')}</p>
    {state.unsupported && <p role="alert" className="text-sm text-destructive">{t('updateRequired')}</p>}
    {state.error && <p role="alert" className="text-sm text-destructive">{t('failed')} · {state.error}</p>}
    <div className="divide-y divide-border">{state.report.slice(reportPage * 10, reportPage * 10 + 10).map((row, index) => <p key={index} className="break-all py-2 text-sm"><span className="text-text-secondary">{t(`fields.${row.field}`)}</span> · {row.value ?? '—'}</p>)}</div>
    <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={!reportPage} onClick={() => setReportPage(page => page - 1)}>{t('previous')}</Button><Button size="sm" variant="ghost" disabled={(reportPage + 1) * 10 >= state.report.length} onClick={() => setReportPage(page => page + 1)}>{t('next')}</Button></div>
    {!readOnly && <>
      <h4 className="text-sm font-medium">{t('target')}</h4>
      {state.targets?.items.map(row => <Button key={row.targetHandle} size="sm" variant={state.selectedTarget === row.targetHandle ? 'secondary' : 'outline'} data-testid="migration-project-target" disabled={state.busy || registering} onClick={() => void model.selectTarget(row.targetHandle)}>{row.displayName}</Button>)}
      <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={state.busy || !state.targets?.pageIndex} onClick={() => void model.targetPage(state.targets!.pageIndex - 1)}>{t('previous')}</Button><Button size="sm" variant="ghost" disabled={state.busy || state.targets?.nextPage == null} onClick={() => void model.targetPage(state.targets!.nextPage!)}>{t('next')}</Button></div>
      {state.targetRoots?.roots.map(root => <p key={root.targetRootHandle} className="break-all text-xs text-text-secondary">{root.path} · {t(root.available && root.trusted ? 'trusted' : 'untrusted')}</p>)}
      {state.sourceRoots.map(row => <label key={row.id} className="block space-y-1 text-sm"><span className="break-all">{row.path}</span><SettingsSelect data-testid="migration-project-root-map" aria-label={row.path} className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm" disabled={state.busy || registering || !state.targetRoots} value={state.mappings[row.id] ?? ''} onChange={event => model.map(row.id, event.target.value)}><option value="">{t('choose')}</option>{state.targetRoots?.roots.map(root => <option key={root.targetRootHandle} value={root.targetRootHandle} disabled={!root.available || !root.trusted}>{root.path}</option>)}</SettingsSelect></label>)}
      <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={state.busy || !state.targetRoots?.pageIndex} onClick={() => void model.rootPage(state.targetRoots!.pageIndex - 1)}>{t('previous')}</Button><Button size="sm" variant="ghost" disabled={state.busy || state.targetRoots?.nextPage == null} onClick={() => void model.rootPage(state.targetRoots!.nextPage!)}>{t('next')}</Button></div>
      <details className="space-y-2"><summary className="cursor-pointer text-sm">{t('register')}</summary><p className="text-xs leading-5 text-text-secondary">{t('registerBoundary')}</p><input aria-label={t('name')} data-testid="migration-project-register-name" className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm" placeholder={t('name')} value={name} disabled={registering || registrationUnknown} onChange={event => setName(event.target.value)} maxLength={256}/><input aria-label={t('directory')} data-testid="migration-project-register-path" className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm" placeholder={t('directory')} value={path} disabled={registering || registrationUnknown} onChange={event => setPath(event.target.value)} maxLength={4096}/><Button size="sm" data-testid="migration-project-register" disabled={state.busy || registering || registrationUnknown || !!state.error || !state.report.length || !name.trim() || !path.trim()} onClick={() => void register()}>{t('register')}</Button>{registrationError && <p role="alert" className="text-sm text-destructive">{t(registrationUnknown ? 'registrationUnknown' : 'registrationConflict')}</p>}</details>
      <Button size="sm" variant="ghost" data-testid="migration-project-refresh" disabled={state.busy || registering} onClick={() => { catalog?.reset(); void model.load(jobId, itemId) }}>{t('refresh')}</Button>
      <div className="flex gap-2"><Button data-testid="migration-project-map-save" disabled={state.busy || registering || !state.canSave} onClick={() => { const choice = model.choice(itemId); if (choice && isCurrent()) onSave?.(choice) }}>{t('select')}</Button><Button variant="ghost" onClick={onCancel}>{t('close')}</Button></div>
    </>}
  </section>
}
