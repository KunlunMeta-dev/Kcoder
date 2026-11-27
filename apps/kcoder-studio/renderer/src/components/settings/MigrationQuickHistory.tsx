import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowRight, CheckCircle2, Loader2, Pause, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/hooks/useTranslation'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { useStudioWorkMode } from '@/features/workbench/studioWorkMode'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { migrationSourceRecoveryScope } from '@/kcoder/migrationSourceTransferScope'
import {
  QuickHistoryMigration,
  type QuickSource,
  type QuickRow,
} from '@/kcoder/migrationQuickHistory'
import type { GatewayServer } from '@/kcoder/gatewayRpc'

export function MigrationQuickHistory({
  target,
  workspacePath,
  isCurrent,
  onBusy,
}: {
  target: GatewayServer
  workspacePath?: string
  isCurrent: () => boolean
  onBusy: (busy: boolean) => void
}) {
  const { t } = useTranslation('migration')
  const workbench = useContext(WorkbenchContext)
  const mode = useStudioWorkMode()
  const namespace = migrationSourceRecoveryScope({ ...target, workspacePath })
  const model = useMemo(() => {
    const account = captureAccountContextRevision()
    return new QuickHistoryMigration({
      api: createMigrationApi(target.id, workspacePath),
      namespace,
      isCurrent: () => isCurrent() && account(target.id),
    })
  }, [target.id, workspacePath, namespace, isCurrent])
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot)
  const [sources, setSources] = useState<QuickSource[]>(['claude-code', 'codex'])
  const [page, setPage] = useState(0)
  const [opening, setOpening] = useState<string | null>(null)
  const [openError, setOpenError] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    model.activate()
    return () => {
      mounted.current = false
      model.dispose()
    }
  }, [model])
  useEffect(() => {
    onBusy(state.busy)
    return () => onBusy(false)
  }, [state.busy, onBusy])
  const archived = state.rows.filter(row => row.archiveReady).length
  const active = state.rows.filter(
    row => row.status === 'archiving' || row.status === 'continuing'
  ).length
  const imported = state.rows.filter(row => row.status === 'imported').length
  const failed = state.rows.filter(row => row.status === 'failed').length
  const refreshWorkLists = workbench?.refreshWorkLists
  useEffect(() => {
    if (imported && !state.busy)
      void refreshWorkLists?.().catch(() => {
        /* The Native receipts remain authoritative. */
      })
  }, [imported, state.busy, refreshWorkLists])
  const open = async (row: QuickRow) => {
    if (!workbench || !row.threadId || opening || !isCurrent()) return
    const account = captureAccountContextRevision()
    setOpening(row.jobId)
    setOpenError(false)
    try {
      await workbench.refreshWorkLists()
      if (mounted.current && isCurrent() && account(target.id))
        await workbench.openRuntimeTask({
          deviceId: target.id,
          taskId: `kcoder:${target.id}:${row.threadId}`,
          workspacePath,
        })
    } catch {
      if (mounted.current && isCurrent() && account(target.id)) setOpenError(true)
    } finally {
      if (mounted.current && account(target.id)) setOpening(null)
    }
  }
  const lastPage = Math.max(0, Math.ceil(state.rows.length / 10) - 1)
  const visiblePage = Math.min(page, lastPage)
  return (
    <section
      data-testid="migration-quick-history"
      data-phase={state.phase}
      className="mt-5 space-y-4"
      aria-busy={state.busy}
    >
      <div className="space-y-2">
        <h3 className="text-base font-medium">{t('quickHistory.title')}</h3>
        <p className="text-sm leading-6 text-text-secondary">{t('quickHistory.description')}</p>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {(['claude-code', 'codex'] as const).map(source => (
          <label key={source} className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              data-testid={`migration-quick-source-${source}`}
              checked={sources.includes(source)}
              disabled={state.busy}
              onChange={event =>
                setSources(old =>
                  event.target.checked ? [...old, source] : old.filter(value => value !== source)
                )
              }
            />
            {source === 'claude-code' ? 'Claude Code' : 'Codex'}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          data-testid="migration-quick-start"
          disabled={state.busy || !sources.length}
          onClick={() => {
            setPage(0)
            setOpenError(false)
            void model.start(sources, mode)
          }}
        >
          {state.busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          ) : state.phase === 'idle' ? (
            <ArrowRight className="mr-2 h-4 w-4" aria-hidden="true" />
          ) : (
            <RotateCw className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          {t(
            state.busy
              ? 'quickHistory.running'
              : state.phase === 'idle'
                ? 'quickHistory.start'
                : 'quickHistory.continue'
          )}
        </Button>
        {state.busy && (
          <Button
            variant="outline"
            data-testid="migration-quick-pause"
            onClick={() => void model.pause()}
          >
            <Pause className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('quickHistory.pause')}
          </Button>
        )}
        <span className="text-xs text-text-muted">
          {t('quickHistory.defaults', { mode: mode === 'kworker' ? 'KWorker' : 'KCoder' })}
        </span>
      </div>
      {state.phase !== 'idle' && (
        <div role="status" className="space-y-1 text-sm" data-testid="migration-quick-progress">
          <p className="font-medium">{t(`quickHistory.phases.${state.phase}`)}</p>
          <p className="text-text-secondary">
            {t('quickHistory.progress', {
              total: state.rows.length,
              archived,
              imported,
              failed,
              active,
            })}
          </p>
          {state.requiresUpdate && (
            <p className="text-text-secondary">
              {t('quickHistory.legacyTargetUpdate', { count: state.concurrency })}
            </p>
          )}
          {state.phase === 'paused' && (
            <p className="text-text-secondary">{t('quickHistory.pausedHelp')}</p>
          )}
          {state.phase === 'complete' && !state.rows.length && !state.warnings.length && (
            <p>{t('quickHistory.empty')}</p>
          )}
        </div>
      )}
      {(state.error || openError) && (
        <p role="alert" className="text-sm text-destructive">
          {openError
            ? t('continuation.open_failed')
            : t(`errors.${state.error}`, { defaultValue: t('quickHistory.failed') })}
        </p>
      )}
      {state.warnings.length > 0 && (
        <div role="alert" className="space-y-1 text-sm text-destructive">
          {state.warnings.map(row => (
            <p key={`${row.source}:${row.code}`}>
              {row.source === 'claude-code' ? 'Claude Code' : 'Codex'} ·{' '}
              {t(`errors.${row.code}`, { defaultValue: t('quickHistory.incomplete') })}
            </p>
          ))}
        </div>
      )}
      {state.rows.length > 0 && (
        <div className="studio-card divide-y divide-border rounded-lg border border-border">
          {state.rows.slice(visiblePage * 10, visiblePage * 10 + 10).map(row => (
            <div
              key={`${row.catalogId}:${row.source.sourceHandle}`}
              className="flex min-h-11 items-center gap-3 px-3 py-3"
              data-testid="migration-quick-row"
              data-migration-status={row.status}
              data-error-code={row.error}
            >
              {row.status === 'imported' && (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-sm"
                  title={row.source.title || row.source.sourceSessionId}
                >
                  {row.source.title || row.source.sourceSessionId}
                </p>
                <p className="text-xs text-text-muted">
                  {row.source.source === 'claude-code' ? 'Claude Code' : 'Codex'} ·{' '}
                  {t(`quickHistory.statuses.${row.status}`)}
                </p>
                {row.error && (
                  <p className="mt-1 break-words text-xs text-destructive">
                    {t(`errors.${row.error}`, { defaultValue: t('quickHistory.failed') })}
                  </p>
                )}
                {row.status === 'imported' && row.reconstructed && (
                  <p className="mt-1 text-xs text-text-secondary">{t('quickHistory.reconstructed')}</p>
                )}
              </div>
              {row.status === 'imported' && workbench && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={opening !== null}
                  onClick={() => void open(row)}
                >
                  {t('continuation.open')}
                </Button>
              )}
            </div>
          ))}
          <div className="flex items-center justify-end gap-2 px-3 py-2">
            <span className="text-xs text-text-muted">
              {visiblePage + 1} / {lastPage + 1}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={visiblePage === 0}
              onClick={() => setPage(visiblePage - 1)}
            >
              {t('previous')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={visiblePage === lastPage}
              onClick={() => setPage(visiblePage + 1)}
            >
              {t('next')}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
