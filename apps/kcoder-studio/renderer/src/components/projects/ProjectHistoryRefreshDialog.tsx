import { Checkbox } from '@/components/ui/checkbox'
import { useEffect, useRef, useState } from 'react'
import { RuntimeTargetConfirmDialog } from '@/components/settings/RuntimeTargetConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import {
  advanceHistoryRefresh,
  cancelHistoryRefresh,
  requestHistoryRefresh,
} from '@/kcoder/gatewayHistoryApi'
import type { HistoryRefreshResult } from '@/kcoder/gatewayHistoryRefresh'
import { normalizeDevicePath } from '@/lib/device-workspace-path'
import type { RuntimeDeviceWorkspace } from '@/types/api'

export function ProjectHistoryRefreshDialog({
  workspaces,
  onClose,
  onReady,
}: {
  workspaces: RuntimeDeviceWorkspace[]
  onClose: () => void
  onReady?: () => Promise<void>
}) {
  const { t } = useTranslation('common')
  // Normalized once so the selector text, the identity keys and the refresh
  // request all read the same namespace-free value.
  const available = workspaces
    .filter(
      value =>
        value.available && value.deviceStatus !== 'offline' && value.deviceId && value.workspacePath
    )
    .map(value => ({ ...value, workspacePath: normalizeDevicePath(value.workspacePath) }))
  const [target, setTarget] = useState(available[0])
  const [acknowledged, setAcknowledged] = useState(false)
  const [pending, setPending] = useState(false)
  const [paused, setPaused] = useState(false)
  const [progress, setProgress] = useState<HistoryRefreshResult>()
  const [error, setError] = useState<string>()
  const closed = useRef(false)
  const running = useRef(false)
  const cursor = useRef<string | undefined>(undefined)
  const restoreFocus = useRef(document.activeElement as HTMLElement | null)
  const request = useRef((input: Parameters<typeof requestHistoryRefresh>[1]) =>
    requestHistoryRefresh(target, input)
  )
  useEffect(() => {
    request.current = input => requestHistoryRefresh(target, input)
  }, [target])

  useEffect(() => {
    closed.current = false
    const focusTarget = restoreFocus.current
    return () => {
      closed.current = true
      // An in-flight step owns cancellation until it returns its replacement cursor.
      if (!running.current)
        void cancelHistoryRefresh(input => request.current(input), cursor.current)
      if (focusTarget?.isConnected) focusTarget.focus()
    }
  }, [])

  const close = () => {
    closed.current = true
    if (!running.current) {
      const current = cursor.current
      cursor.current = undefined
      void cancelHistoryRefresh(input => request.current(input), current)
    }
    onClose()
  }

  const advance = async () => {
    if (progress?.status === 'ready') {
      close()
      return
    }
    if (running.current || !target || (!acknowledged && !cursor.current)) return
    running.current = true
    setPending(true)
    setPaused(false)
    setError(undefined)
    const step = (input: Parameters<typeof requestHistoryRefresh>[1]) =>
      requestHistoryRefresh(target, input)
    try {
      const outcome = await advanceHistoryRefresh(step, {
        cursor: cursor.current,
        cancelled: () => closed.current,
        onCursor: value => {
          cursor.current = value
        },
        onProgress: value => {
          if (!closed.current) setProgress(value)
        },
      })
      if (closed.current) return
      setPaused(outcome.paused)
      if (outcome.result?.status === 'ready') await onReady?.()
    } catch (failure) {
      if (!closed.current) {
        const message = failure instanceof Error ? failure.message : String(failure)
        setError(
          message.includes('threadHistoryIndexRefresh')
            ? t('history_refresh.unsupported')
            : t('history_refresh.failure', { message })
        )
      }
    } finally {
      running.current = false
      if (!closed.current) setPending(false)
    }
  }

  const complete = progress?.status === 'ready'
  return (
    <RuntimeTargetConfirmDialog
      title={t('history_refresh.title')}
      description={t('history_refresh.description')}
      testId="project-history-refresh-dialog"
      cancelLabel={pending || paused ? t('history_refresh.cancel') : t('history_refresh.close')}
      closeLabel={t('history_refresh.close')}
      confirmLabel={
        complete
          ? t('history_refresh.close')
          : paused
            ? t('history_refresh.continue')
            : error || progress?.status === 'incomplete'
              ? t('history_refresh.retry')
              : t('history_refresh.start')
      }
      confirmDisabled={pending || !target || (!complete && !acknowledged)}
      onCancel={close}
      onConfirm={() => {
        void advance()
      }}
    >
      <label className="block text-sm text-text-secondary">
        {t('history_refresh.target')}
        <select
          data-testid="history-refresh-target"
          className="mt-2 block min-h-11 w-full rounded-lg border border-border bg-background px-3 text-base text-text-primary focus-visible:outline-blue-500"
          disabled={pending || paused || complete}
          value={target ? JSON.stringify([target.deviceId, target.workspacePath]) : ''}
          onChange={event => {
            setTarget(
              available.find(
                value =>
                  JSON.stringify([value.deviceId, value.workspacePath]) === event.target.value
              )!
            )
            setProgress(undefined)
            setError(undefined)
          }}
        >
          {available.map(value => (
            <option
              key={JSON.stringify([value.deviceId, value.workspacePath])}
              value={JSON.stringify([value.deviceId, value.workspacePath])}
            >
              {value.deviceName || value.deviceId} · {value.workspacePath}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-h-11 items-start gap-2 text-sm text-text-secondary">
        <Checkbox
          data-testid="history-refresh-acknowledge"
          className="mt-1"
          checked={acknowledged}
          disabled={pending || paused || complete}
          onChange={event => setAcknowledged(event.target.checked)}
        />
        {t('history_refresh.acknowledge')}
      </label>
      <div
        role="status"
        aria-live="polite"
        data-testid="history-refresh-progress"
        className="space-y-2 text-sm text-text-secondary"
      >
        {pending && <p>{t('history_refresh.running')}</p>}
        {progress && (
          <p>
            {t('history_refresh.progress', {
              examined: progress.examinedEntries,
              indexed: progress.indexedSessions,
              issues: progress.issueCount,
            })}
          </p>
        )}
        {complete && <p>{t('history_refresh.ready')}</p>}
        {progress?.status === 'incomplete' && <p>{t('history_refresh.incomplete')}</p>}
        {progress?.status === 'incomplete' && progress.issues && progress.issues.length > 0 && (
          <>
            <p className="text-xs font-medium">{t('history_refresh.issue_details')}</p>
            <ul
              data-testid="history-refresh-issues"
              className="max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-xs"
            >
              {progress.issues.slice(0, 10).map((issue, index) => (
                <li key={index} className="break-all">
                  {issue.sessionId ? `${issue.sessionId}: ` : ''}
                  {issue.reason}
                </li>
              ))}
            </ul>
          </>
        )}
        {progress?.status === 'cancelled' && <p>{t('history_refresh.cancelled')}</p>}
        {paused && <p>{t('history_refresh.paused')}</p>}
      </div>
      {error && (
        <p role="alert" className="break-words text-sm text-red-500">
          {error}
        </p>
      )}
    </RuntimeTargetConfirmDialog>
  )
}
