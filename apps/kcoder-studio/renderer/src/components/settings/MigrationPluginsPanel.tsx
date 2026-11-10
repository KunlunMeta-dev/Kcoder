import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { useMigrationPlugins } from '@/kcoder/useMigrationPlugins'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
export function MigrationPluginsPanel({
  deviceId,
  workspacePath,
  isCurrent,
  onSelectForBatch,
  sourceKind,
  onBusy,
}: {
  deviceId: string
  workspacePath?: string
  isCurrent: () => boolean
  onSelectForBatch?: (operationId: string, sequence: number, name: string) => void
  sourceKind?: 'claude-code' | 'codex'
  onBusy?: (value: boolean) => void
}) {
  const { t } = useTranslation('migrationPlugins')
  const model = useMigrationPlugins(deviceId, workspacePath, isCurrent, sourceKind)
  const mappingScope = useMemo(
    () => ({ deviceId, workspacePath, kind: model.kind }),
    [deviceId, workspacePath, model.kind]
  )
  const [mappingConsent, setMappingConsent] = useState<{
    scope: object
    accountCurrent: (target: string) => boolean
  } | null>(null)
  const mapProject =
    mappingConsent?.scope === mappingScope && mappingConsent.accountCurrent(deviceId) && isCurrent()
  const setMapProject = (enabled: boolean) =>
    setMappingConsent(
      enabled ? { scope: mappingScope, accountCurrent: captureAccountContextRevision() } : null
    )
  const job = model.state?.job,
    running = Boolean(model.state?.workerRunning)
  const confirmationScope = useMemo(
    () => ({ deviceId, workspacePath, operationId: job?.operationId }),
    [deviceId, workspacePath, job?.operationId]
  )
  const [requestedConfirmation, setConfirmation] = useState<{
    action: 'apply' | 'undo'
    id: string
    name: string
    sequence: number
    scope: object
    accountCurrent: (target: string) => boolean
  } | null>(null)
  const confirmation =
    requestedConfirmation?.scope === confirmationScope &&
    requestedConfirmation.id === job?.operationId &&
    requestedConfirmation.sequence === job.sequence &&
    requestedConfirmation.accountCurrent(deviceId) &&
    isCurrent()
      ? requestedConfirmation
      : null
  const requestConfirmation = (action: 'apply' | 'undo') => {
    if (!job || !isCurrent() || model.busy || running || job.batchJobId) return
    setConfirmation({
      action,
      id: job.operationId,
      name: job.name,
      sequence: job.sequence,
      scope: confirmationScope,
      accountCurrent: captureAccountContextRevision(),
    })
  }
  const error = (code: string) => t(`errors.${code}`, { defaultValue: t('unknown') })
  const pending = model.busy || running
  useEffect(() => {
    onBusy?.(pending)
    return () => onBusy?.(false)
  }, [pending, onBusy])
  return (
    <section
      className="space-y-3 border-t border-border pt-4"
      data-testid="migration-plugins"
      aria-busy={model.busy}
    >
      <div className="space-y-1">
        <h3 className="text-base font-medium">{t('title')}</h3>
        <p className="text-sm text-text-secondary">
          {t(onSelectForBatch ? 'batchBoundary' : 'boundary')}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-sm">
          <span className="block">{t('source')}</span>
          <SettingsSelect
            data-testid="migration-plugin-source"
            className="h-10 rounded-lg border border-border bg-surface px-3 text-base"
            value={model.kind}
            disabled={model.busy || Boolean(sourceKind)}
            onChange={event =>
              model.setKind(event.target.value === 'codex' ? 'codex' : 'claude-code')
            }
          >
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
          </SettingsSelect>
        </label>
        <Button
          size="sm"
          variant="outline"
          data-testid="migration-plugin-discover"
          disabled={model.busy}
          onClick={() => void model.discover()}
        >
          {t('discover')}
        </Button>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={model.includeProject}
          disabled={pending || !workspacePath}
          onChange={event => {
            model.setIncludeProject(event.target.checked)
            setMapProject(false)
          }}
        />
        {t('project.include')}
      </label>
      {model.includeProject && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={mapProject}
            disabled={pending || !workspacePath}
            onChange={event => setMapProject(event.target.checked)}
          />
          {t('project.map')}
        </label>
      )}
      {model.error && (
        <p role="alert" className="text-sm text-destructive">
          {error(model.error)}
        </p>
      )}
      {model.catalog && (
        <div className="space-y-2">
          {!model.catalog.candidates.length && (
            <p className="text-sm text-text-secondary" role="status">
              {t('empty')}
            </p>
          )}
          {model.catalog.candidates.map(candidate => (
            <div
              key={candidate.candidateId}
              className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border py-2"
              data-testid={`migration-plugin-candidate-${candidate.candidateId}`}
            >
              <div className="min-w-0">
                <p className="break-words text-sm font-medium">
                  {candidate.name} {candidate.installedVersion ?? ''}
                </p>
                <p className="text-xs text-text-secondary">
                  {t(`scope.${candidate.scope}`, { defaultValue: t('scope.unknown') })}
                </p>
                {candidate.pending.length > 0 && (
                  <p className="text-sm text-warning">{t('review')}</p>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                data-testid={`migration-plugin-prepare-${candidate.candidateId}`}
                disabled={
                  model.busy ||
                  candidate.pending.some(code => code !== 'plugin_project_mapping_required') ||
                  (candidate.scope !== 'user' &&
                    (!['project', 'local'].includes(candidate.scope) ||
                      !mapProject ||
                      !workspacePath))
                }
                onClick={() =>
                  void model.plan(
                    candidate.candidateId,
                    undefined,
                    candidate.scope !== 'user' && mapProject
                  )
                }
              >
                {t('prepare')}
              </Button>
            </div>
          ))}
          {model.catalog.problems.map((problem, index) => (
            <p key={`${problem.kind}-${index}`} className="text-sm text-warning" role="status">
              {error(problem.code)}
            </p>
          ))}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              data-testid="migration-plugin-source-previous"
              disabled={model.busy || model.sourcePage === 0}
              onClick={model.previousSources}
            >
              {t('previous')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="migration-plugin-source-next"
              disabled={model.busy || !model.catalog.nextCursor}
              onClick={() => void model.discover(model.catalog?.nextCursor ?? undefined)}
            >
              {t('next')}
            </Button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium">{t('records')}</h4>
          <Button
            size="sm"
            variant="ghost"
            data-testid="migration-plugin-record-refresh"
            disabled={model.busy}
            onClick={() => void model.listRecords()}
          >
            {t('refresh')}
          </Button>
        </div>
        {model.records && !model.records.items.length && (
          <p className="text-sm text-text-secondary">{t('noRecords')}</p>
        )}
        {model.records?.items.map(record => (
          <div
            key={record.operationId}
            className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2"
            data-testid={`migration-plugin-record-${record.operationId}`}
          >
            <div className="min-w-0">
              <p className="break-words text-sm">{record.name}</p>
              <p className="text-xs text-text-secondary">{t(`stages.${record.stage}`)}</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              data-testid={`migration-plugin-open-${record.operationId}`}
              disabled={model.busy}
              onClick={() => void model.open(record.operationId)}
            >
              {t('open')}
            </Button>
          </div>
        ))}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            data-testid="migration-plugin-record-previous"
            disabled={model.busy || model.recordPage === 0}
            onClick={model.previousRecords}
          >
            {t('previous')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="migration-plugin-record-next"
            disabled={model.busy || !model.records?.nextCursor}
            onClick={() => void model.listRecords(model.records?.nextCursor ?? undefined)}
          >
            {t('next')}
          </Button>
        </div>
      </div>
      {model.unknownOperation && !job && (
        <div className="space-y-2">
          <p className="text-sm text-warning" role="status">
            {t('unknown')}
          </p>
          <Button
            size="sm"
            variant="outline"
            data-testid="migration-plugin-reconcile"
            onClick={() => void model.refresh()}
          >
            {t('refresh')}
          </Button>
        </div>
      )}
      {job && (
        <div
          className="space-y-2 border-t border-border pt-3"
          data-testid="migration-plugin-result"
        >
          <p className="break-words text-sm font-medium">{job.name}</p>
          <p role="status" className="text-sm">
            {t(`stages.${job.stage}`)}
            {running ? ` · ${t('running')}` : ''}
          </p>
          {(job.failureCode || model.state?.workerError) && (
            <p role="alert" className="text-sm text-destructive">
              {error(job.failureCode ?? model.state?.workerError ?? '')}
            </p>
          )}
          {job.pending.length > 0 && <p className="text-sm text-warning">{t('review')}</p>}
          {job.readiness.length > 0 && (
            <p className="text-sm text-text-secondary">{t('environment')}</p>
          )}
          {job.batchJobId && <p className="text-sm text-text-secondary">{t('batch')}</p>}
          <div className="flex flex-wrap gap-2">
            {!job.batchJobId &&
              !pending &&
              !job.cancelRequested &&
              ['prepared', 'outcome_unknown'].includes(job.stage) &&
              !job.imported && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="migration-plugin-capture"
                  onClick={() => void model.capture()}
                >
                  {t('capture')}
                </Button>
              )}
            {!onSelectForBatch &&
              !job.batchJobId &&
              !pending &&
              !job.cancelRequested &&
              job.stage === 'ready' && (
                <Button
                  size="sm"
                  data-testid="migration-plugin-apply"
                  onClick={() => requestConfirmation('apply')}
                >
                  {t('apply')}
                </Button>
              )}
            {!onSelectForBatch &&
              !job.batchJobId &&
              !pending &&
              job.imported &&
              job.stage !== 'undone' && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="migration-plugin-undo"
                  onClick={() => requestConfirmation('undo')}
                >
                  {t('undo')}
                </Button>
              )}
            {!job.batchJobId &&
              !running &&
              !model.busy &&
              ['cancelled', 'outcome_unknown'].includes(job.stage) && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="migration-plugin-resume"
                  onClick={() => void model.resume()}
                >
                  {t('resume')}
                </Button>
              )}
            {!job.batchJobId && (running || model.busy) && (
              <Button
                size="sm"
                variant="outline"
                data-testid="migration-plugin-cancel"
                disabled={job.cancelRequested}
                onClick={() => void model.cancel()}
              >
                {t(job.cancelRequested ? 'cancelling' : 'cancel')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              data-testid="migration-plugin-refresh"
              onClick={() => void model.refresh()}
            >
              {t('refresh')}
            </Button>
            {onSelectForBatch &&
              !pending &&
              job.stage === 'ready' &&
              !job.batchJobId &&
              !job.cancelRequested && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="migration-plugin-select-batch"
                  onClick={() => {
                    if (isCurrent()) onSelectForBatch(job.operationId, job.sequence, job.name)
                  }}
                >
                  {t('useBatch')}
                </Button>
              )}
          </div>
          <details className="text-xs text-text-secondary">
            <summary data-testid="migration-plugin-details" className="cursor-pointer">
              {t('details')}
            </summary>
            <code className="block break-all pt-2">{job.operationId}</code>
            {job.targetId && <code className="block break-all">{job.targetId}</code>}
          </details>
        </div>
      )}
      {confirmation && (
        <ModalDialog
          title={t(confirmation.action === 'apply' ? 'apply' : 'undo')}
          testId="migration-plugin-confirmation"
          closeLabel={t('close')}
          pending={model.busy}
          onClose={() => setConfirmation(null)}
        >
          <p className="py-4 text-sm">
            {t(confirmation.action === 'apply' ? 'confirmApply' : 'confirmUndo', {
              name: confirmation.name,
            })}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              data-testid="migration-plugin-confirm-cancel"
              disabled={model.busy}
              onClick={() => setConfirmation(null)}
            >
              {t('close')}
            </Button>
            <Button
              size="sm"
              variant={confirmation.action === 'undo' ? 'destructive' : 'default'}
              data-testid="migration-plugin-confirm"
              disabled={pending || Boolean(job?.batchJobId)}
              onClick={() => {
                if (
                  pending ||
                  job?.batchJobId ||
                  job?.operationId !== confirmation.id ||
                  job.sequence !== confirmation.sequence ||
                  !confirmation.accountCurrent(deviceId) ||
                  !isCurrent()
                )
                  return
                void model[confirmation.action]().then(done => {
                  if (done) setConfirmation(current => (current === confirmation ? null : current))
                })
              }}
            >
              {t('confirm')}
            </Button>
          </div>
        </ModalDialog>
      )}
    </section>
  )
}
