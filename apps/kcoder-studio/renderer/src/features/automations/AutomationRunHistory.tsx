import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
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
  const { t, i18n } = useTranslation('common')
  const { deviceId, workspacePath } = address
  const scope = `${deviceId}\0${workspacePath}`
  const [listing, setListing] = useState<{
    scope: string
    runs: AutomationExecution[]
    supported: boolean
  } | null>(null)
  const [failure, setFailure] = useState<{
    scope: string
    message: string
    operation?: 'open'
  } | null>(null)
  const [opening, setOpening] = useState<{ scope: string; triggerId: string } | null>(null)
  const currentScope = useRef<string | null>(null)
  const generation = useRef(0)
  const inFlight = useRef<{ scope: string; generation: number } | null>(null)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const rows = listing?.scope === scope ? listing.runs : []
  const refresh = useCallback(async () => {
    if (inFlight.current?.scope === scope) return
    const current = ++generation.current
    inFlight.current = { scope, generation: current }
    setRefreshing(scope)
    try {
      const result = await requestAutomation<unknown>({ deviceId, workspacePath }, 'cron/list')
      if (current !== generation.current) return
      const diagnostics = automationExecutionDiagnostics(result)
      setListing({
        scope,
        runs: (diagnostics?.runs ?? []).filter(
          run => !run.workspacePath || sameWorkspacePath(run.workspacePath, workspacePath)
        ),
        supported: Boolean(diagnostics),
      })
      setFailure(current =>
        current?.scope === scope && current.operation === 'open' ? current : null
      )
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
  const formatTime = (value: string) => {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(i18n.language)
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
          disabled={refreshing === scope}
          aria-busy={refreshing === scope}
          onClick={() => void refresh()}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      <p className="text-sm text-text-secondary">{t('automations.execution.conditions')}</p>
      {failure?.scope === scope && (
        <p role="alert" className="text-sm text-red-500">
          {t(
            `automations.execution.${failure.operation === 'open' ? 'openFailed' : 'refreshFailed'}`,
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
        <p className="text-sm text-text-secondary">{t('automations.execution.empty')}</p>
      )}
      <div className="divide-y divide-border">
        {rows.map(run => (
          <article
            key={run.triggerId}
            className="space-y-2 py-3"
            data-testid="automation-run"
            data-trigger-id={run.triggerId}
            data-status={run.status}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-base font-medium break-words">{run.title || run.jobId}</p>
              <p role="status" className="text-sm text-text-secondary">
                {t(`automations.execution.status.${run.status}`)}
              </p>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
              <span>
                {t('automations.execution.scheduled', { time: formatTime(run.scheduledAt) })}
              </span>
              {run.startedAt && (
                <span>
                  {t('automations.execution.started', { time: formatTime(run.startedAt) })}
                </span>
              )}
              {run.finishedAt && (
                <span>
                  {t('automations.execution.finished', { time: formatTime(run.finishedAt) })}
                </span>
              )}
              {run.timezone && (
                <span>{t('automations.execution.timezone', { timezone: run.timezone })}</span>
              )}
              {run.model && <span>{t('automations.execution.model', { model: run.model })}</span>}
              {Boolean(run.coalesced) && (
                <span>{t('automations.execution.coalescedCount', { count: run.coalesced })}</span>
              )}
            </div>
            {run.status === 'expired' && (
              <p className="text-sm text-text-secondary">{t('automations.execution.expired')}</p>
            )}
            {run.status === 'unknown' && (
              <p className="text-sm text-text-secondary">{t('automations.execution.noReplay')}</p>
            )}
            {run.status === 'coalesced' && (
              <p className="text-sm text-text-secondary">
                {t('automations.execution.merged', { trigger: run.mergedIntoTriggerId })}
              </p>
            )}
            {run.error && (
              <p role="alert" className="text-sm whitespace-pre-wrap break-words text-red-500">
                {t('automations.execution.failure', {
                  stage: t(`automations.execution.stage.${run.failureStage || 'execution'}`),
                  message:
                    run.error === 'empty_reply' ? t('automations.execution.emptyReply') : run.error,
                })}
              </p>
            )}
            {run.replyPreview && (
              <p className="text-sm whitespace-pre-wrap break-words">{run.replyPreview}</p>
            )}
            {run.threadId && onOpenTask && (
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-0"
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
                {t('automations.execution.openThread')}
              </Button>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}
