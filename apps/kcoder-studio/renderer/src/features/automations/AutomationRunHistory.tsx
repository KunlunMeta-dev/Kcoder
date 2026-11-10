import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { requestAutomation, type AutomationProjectAddress } from '@/kcoder/gatewayAutomationApi'
import {
  automationExecutionDiagnostics,
  type AutomationExecution,
} from '@/kcoder/automationCapabilities'
import type { RuntimeTaskAddress } from '@/types/api'
import { runtimeTaskId } from '@/kcoder/gateway/runtime/contracts'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'

export function AutomationRunHistory({
  address,
  onOpenTask,
}: {
  address: AutomationProjectAddress
  onOpenTask?: (address: RuntimeTaskAddress) => Promise<unknown>
}) {
  const { t } = useTranslation('common')
  const { deviceId, workspacePath } = address
  const scope = `${deviceId}\0${workspacePath}`
  const [listing, setListing] = useState<{
    scope: string
    runs: AutomationExecution[]
    supported: boolean
    deletionSupported: boolean
    pageIndex: number
  } | null>(null)
  const [failure, setFailure] = useState<{
    scope: string
    message: string
    operation?: 'open' | 'delete'
  } | null>(null)
  const [opening, setOpening] = useState<{ scope: string; triggerId: string } | null>(null)
  const [deleting, setDeleting] = useState<{ scope: string; triggerId: string } | null>(null)
  const deletion = useRef<{ scope: string; triggerId: string } | null>(null)
  const currentScope = useRef<string | null>(null)
  const generation = useRef(0)
  const inFlight = useRef<{ scope: string; generation: number } | null>(null)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const rows = listing?.scope === scope ? listing.runs : []
  const pageCount = Math.max(1, Math.ceil(rows.length / 10))
  const pageIndex = listing?.scope === scope ? Math.min(listing.pageIndex, pageCount - 1) : 0
  const visibleRows = rows.slice(pageIndex * 10, (pageIndex + 1) * 10)
  const refresh = useCallback(async () => {
    if (inFlight.current?.scope === scope || deletion.current?.scope === scope) return
    const current = ++generation.current
    inFlight.current = { scope, generation: current }
    setRefreshing(scope)
    try {
      const result = await requestAutomation<unknown>({ deviceId, workspacePath }, 'cron/list')
      if (current !== generation.current) return
      const diagnostics = automationExecutionDiagnostics(result)
      const runs = (diagnostics?.runs ?? []).filter(
        run => !run.workspacePath || sameWorkspacePath(run.workspacePath, workspacePath)
      )
      setListing(current => ({
        scope,
        runs,
        pageIndex:
          current?.scope === scope
            ? Math.min(current.pageIndex, Math.max(0, Math.ceil(runs.length / 10) - 1))
            : 0,
        supported: Boolean(diagnostics),
        deletionSupported: diagnostics?.historyDeletionSupported === true,
      }))
      setFailure(current => (current?.scope === scope && current.operation ? current : null))
    } catch (error) {
      if (current === generation.current) {
        setFailure({ scope, message: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      if (inFlight.current?.generation === current) {
        inFlight.current = null
        setRefreshing(null)
      }
    }
  }, [deviceId, workspacePath, scope])
  useEffect(() => {
    const requestGeneration = generation
    const scopeReference = currentScope
    scopeReference.current = scope
    const initial = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => {
      ++requestGeneration.current
      scopeReference.current = null
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [refresh, scope])
  const remove = async (run: AutomationExecution) => {
    if (deletion.current?.scope === scope || !listing?.deletionSupported) return
    const operation = { scope, triggerId: run.triggerId }
    deletion.current = operation
    setDeleting(operation)
    ++generation.current
    inFlight.current = null
    setRefreshing(null)
    try {
      const result = await requestAutomation<{
        deleted: boolean
        historyOnly: boolean
        schedulePreserved: boolean
      }>(address, 'cron/delete', {
        jobId: run.jobId,
        triggerId: run.triggerId,
        receiptsOnly: true,
        confirmed: true,
      })
      if (currentScope.current !== scope) return
      if (
        typeof result.deleted !== 'boolean' ||
        result.historyOnly !== true ||
        result.schedulePreserved !== true
      ) {
        throw new Error(t('automations.execution.deleteUnsupported'))
      }
      setListing(current => {
        if (current?.scope !== scope) return current
        const runs = current.runs.filter(row => row.triggerId !== run.triggerId)
        return {
          ...current,
          runs,
          pageIndex: Math.min(current.pageIndex, Math.max(0, Math.ceil(runs.length / 10) - 1)),
        }
      })
      setFailure(current =>
        current?.scope === scope && current.operation === 'delete' ? null : current
      )
    } catch (error) {
      if (currentScope.current === scope)
        setFailure({
          scope,
          operation: 'delete',
          message: error instanceof Error ? error.message : String(error),
        })
    } finally {
      if (deletion.current === operation) {
        deletion.current = null
        setDeleting(null)
      }
    }
  }
  return (
    <section className="space-y-3" data-testid="automation-run-history">
      <div className="flex items-center justify-between gap-3">
        <h2 className="heading-sm">{t('automations.execution.history')}</h2>
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 min-w-11 md:min-h-0 md:min-w-0"
          data-testid="automation-runs-refresh"
          aria-label={t('automations.refresh')}
          disabled={refreshing === scope || deleting?.scope === scope}
          aria-busy={refreshing === scope}
          onClick={() => void refresh()}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      {failure?.scope === scope && (
        <p role="alert" className="text-sm text-red-500">
          {t(
            `automations.execution.${failure.operation === 'open' ? 'openFailed' : failure.operation === 'delete' ? 'deleteFailed' : 'refreshFailed'}`,
            { message: failure.message }
          )}
        </p>
      )}
      {listing?.scope !== scope && refreshing === scope && (
        <p role="status" className="text-sm text-text-secondary">
          {t('automations.execution.loading')}
        </p>
      )}
      {listing?.scope === scope && !listing.supported && (
        <p className="text-sm text-text-secondary">{t('automations.execution.unsupported')}</p>
      )}
      {listing?.scope === scope && listing.supported && !rows.length && (
        <p className="text-sm text-text-secondary" data-testid="automation-runs-empty">
          {t('automations.execution.empty')}
        </p>
      )}
      <div className="divide-y divide-border">
        {visibleRows.map(run => (
          <article
            key={run.triggerId}
            className="flex min-w-0 items-center gap-2 py-2"
            data-testid="automation-run"
            data-trigger-id={run.triggerId}
            data-status={run.status}
          >
            {run.threadId && onOpenTask ? (
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11 min-w-0 flex-1 justify-start px-0 text-left text-base font-medium md:min-h-0"
                title={run.title?.trim() || run.jobId}
                data-testid="automation-run-open-thread"
                disabled={opening?.scope === scope}
                onClick={async () => {
                  setOpening({ scope, triggerId: run.triggerId })
                  try {
                    await onOpenTask({
                      deviceId: address.deviceId,
                      workspacePath: address.workspacePath,
                      taskId: runtimeTaskId(
                        { id: address.deviceId, runtime: 'kcoder' },
                        run.threadId!
                      ),
                      threadId: run.threadId!,
                    })
                    if (currentScope.current === scope) {
                      setFailure(current =>
                        current?.scope === scope && current.operation === 'open' ? null : current
                      )
                    }
                  } catch (error) {
                    if (currentScope.current === scope) {
                      setFailure({
                        scope,
                        operation: 'open',
                        message: error instanceof Error ? error.message : String(error),
                      })
                    }
                  } finally {
                    if (currentScope.current === scope) setOpening(null)
                  }
                }}
              >
                <span className="truncate">{run.title?.trim() || run.jobId}</span>
              </Button>
            ) : (
              <p
                className="min-w-0 flex-1 truncate text-base font-medium"
                title={run.title?.trim() || run.jobId}
              >
                {run.title?.trim() || run.jobId}
              </p>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11 min-w-11 shrink-0 text-text-secondary hover:text-destructive md:min-h-0 md:min-w-0"
              data-testid="automation-run-delete"
              aria-label={t('automations.execution.deleteRecord', {
                title: run.title?.trim() || run.jobId,
              })}
              title={
                listing?.deletionSupported
                  ? t('automations.execution.deleteRecord', {
                      title: run.title?.trim() || run.jobId,
                    })
                  : t('automations.execution.deleteUnsupported')
              }
              disabled={!listing?.deletionSupported || deleting?.scope === scope}
              aria-busy={deleting?.scope === scope && deleting.triggerId === run.triggerId}
              onClick={() => void remove(run)}
            >
              {deleting?.scope === scope && deleting.triggerId === run.triggerId ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="size-4" aria-hidden="true" />
              )}
            </Button>
          </article>
        ))}
      </div>
      {rows.length > 0 && (
        <nav
          className="flex items-center justify-end gap-3"
          aria-label={t('automations.execution.pagination')}
        >
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 md:min-h-0"
            data-testid="automation-runs-previous"
            disabled={pageIndex === 0}
            onClick={() =>
              setListing(current =>
                current?.scope === scope ? { ...current, pageIndex: pageIndex - 1 } : current
              )
            }
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            {t('automations.execution.previousPage')}
          </Button>
          <span
            className="text-sm tabular-nums text-text-secondary"
            data-testid="automation-runs-page"
          >
            {t('automations.execution.page', { page: pageIndex + 1, total: pageCount })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 md:min-h-0"
            data-testid="automation-runs-next"
            disabled={pageIndex + 1 >= pageCount}
            onClick={() =>
              setListing(current =>
                current?.scope === scope ? { ...current, pageIndex: pageIndex + 1 } : current
              )
            }
          >
            {t('automations.execution.nextPage')}
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
        </nav>
      )}
    </section>
  )
}
