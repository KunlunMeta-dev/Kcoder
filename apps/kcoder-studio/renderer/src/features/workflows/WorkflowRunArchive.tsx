import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import {
  workflowApi,
  type WorkflowRun,
  type WorkflowRunArchivePreview,
  type WorkflowRunArchiveResult,
} from './workflowApi'

export function WorkflowRunArchive({
  serverId,
  isCurrent,
  onArchived,
  onInspect,
}: {
  serverId: string
  isCurrent: () => boolean
  onArchived: () => void
  onInspect: (run: WorkflowRun) => void
}) {
  const { t } = useTranslation('common')
  const epoch = useRef(0)
  const [supported, setSupported] = useState<boolean | null>(null)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [offset, setOffset] = useState(0)
  const [archived, setArchived] = useState(false)
  const [next, setNext] = useState<number | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [preview, setPreview] = useState<WorkflowRunArchivePreview | null>(null)
  const [result, setResult] = useState<WorkflowRunArchiveResult | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    const scopeEpoch = epoch
    workflowApi
      .capabilities(serverId, { signal: controller.signal })
      .then(value => {
        if (!controller.signal.aborted && isCurrent()) setSupported(value.runArchive === true)
      })
      .catch(failure => {
        if (!controller.signal.aborted && isCurrent()) {
          setSupported(false)
          setError(String(failure))
        }
      })
    return () => {
      controller.abort()
      scopeEpoch.current++
    }
  }, [serverId, isCurrent])
  const current = (revision: number) => revision === epoch.current && isCurrent()
  const load = async (from = 0, archiveMode = archived) => {
    const revision = ++epoch.current
    setOpen(true)
    setPending(true)
    setError('')
    setSelected([])
    setPreview(null)
    try {
      const page = archiveMode
        ? await workflowApi.archivedRuns(serverId, from)
        : await workflowApi.runs(serverId, undefined, from)
      if (current(revision)) {
        setArchived(archiveMode)
        setRuns(page.items)
        setNext(page.nextOffset ?? null)
        setOffset(from)
      }
    } catch (failure) {
      if (current(revision)) setError(String(failure))
    } finally {
      if (current(revision)) setPending(false)
    }
  }
  const inspect = async () => {
    if (!selected.length || pending) return
    const revision = ++epoch.current
    setPending(true)
    setError('')
    setPreview(null)
    try {
      const value = await workflowApi.archivePreview(serverId, selected)
      if (current(revision)) setPreview(value)
    } catch (failure) {
      if (current(revision)) setError(String(failure))
    } finally {
      if (current(revision)) setPending(false)
    }
  }
  const confirm = async () => {
    if (!preview || pending || !isCurrent() || preview.entries.some(entry => entry.blockers.length))
      return
    const revision = ++epoch.current
    setPending(true)
    setError('')
    try {
      const value = await workflowApi.archiveRuns(serverId, selected, preview.previewToken, true)
      if (current(revision)) {
        setResult(value)
        setOpen(false)
        setPreview(null)
        onArchived()
      }
    } catch (failure) {
      if (current(revision)) {
        setError(String(failure))
        if (String(failure).includes('workflow_conflict')) setPreview(null)
      }
    } finally {
      if (current(revision)) setPending(false)
    }
  }
  const close = () => {
    epoch.current++
    setOpen(false)
    setPreview(null)
    setPending(false)
  }
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="max-md:min-h-11"
        data-testid="workflow-run-archive-open"
        disabled={supported !== true || pending}
        onClick={() => void load(0, false)}
      >
        {t('workflowRunArchive.manage')}
      </Button>
      {supported === false && (
        <p className="text-xs text-text-muted" data-testid="workflow-run-archive-unsupported">
          {t('workflowRunArchive.unsupported')}
        </p>
      )}
      {result && (
        <p
          role="status"
          className="text-xs text-text-secondary"
          data-testid="workflow-run-archive-result"
        >
          {t(
            result.recoveryPending
              ? 'workflowRunArchive.recoveryPending'
              : 'workflowRunArchive.archived',
            { count: result.archivedRunIds.length, bytes: result.releasedBytes }
          )}
        </p>
      )}
      {open && (
        <ModalDialog
          title={t('workflowRunArchive.manage')}
          testId="workflow-run-archive-dialog"
          pending={pending}
          onClose={close}
          closeLabel={t('workflowRunArchive.cancel')}
        >
          <p className="my-3 text-sm">{t('workflowRunArchive.retained')}</p>
          {pending && (
            <p role="status" className="my-3 text-sm">
              {t('workflowRunArchive.pending')}
            </p>
          )}
          {error && (
            <p role="alert" className="my-3 break-words text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            size="sm"
            variant="ghost"
            data-testid="workflow-run-archive-view-toggle"
            disabled={pending}
            onClick={() => void load(0, !archived)}
          >
            {t(
              archived ? 'workflowRunArchive.activeHistory' : 'workflowRunArchive.archivedHistory'
            )}
          </Button>
          <div className="max-h-64 space-y-2 overflow-auto">
            {runs.map(run => (
              <label
                key={run.runId}
                className="flex min-h-11 items-center gap-2 rounded-lg border border-border p-2 text-sm"
              >
                {archived ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid={`workflow-run-archive-read-${run.runId}`}
                    disabled={pending}
                    onClick={async () => {
                      const revision = ++epoch.current
                      setPending(true)
                      setError('')
                      try {
                        const snapshot = await workflowApi.archivedRun(serverId, run.runId)
                        if (current(revision)) {
                          onInspect(snapshot)
                          close()
                        }
                      } catch (failure) {
                        if (current(revision)) setError(String(failure))
                      } finally {
                        if (current(revision)) setPending(false)
                      }
                    }}
                  >
                    {t('workflowRunArchive.read')}
                  </Button>
                ) : (
                  <Checkbox
                    checked={selected.includes(run.runId)}
                    disabled={pending || run.status === 'running'}
                    data-testid={`workflow-run-archive-select-${run.runId}`}
                    onChange={event => {
                      epoch.current++
                      setPreview(null)
                      setError('')
                      setSelected(ids =>
                        event.target.checked
                          ? [...ids, run.runId]
                          : ids.filter(id => id !== run.runId)
                      )
                    }}
                  />
                )}
                <span className="min-w-0 break-all">
                  {run.runId} · {t(`workflowCanvas.status_${run.status}`, run.status)}
                </span>
              </label>
            ))}
            {!runs.length && !pending && (
              <p className="text-sm text-text-muted">{t('workflowCanvas.noRuns')}</p>
            )}
          </div>
          {(offset > 0 || next != null) && (
            <div className="my-2 flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                data-testid="workflow-run-archive-previous"
                disabled={pending || !offset}
                onClick={() => void load(Math.max(0, offset - 20))}
              >
                {t('workflowCanvas.previous')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="workflow-run-archive-next"
                disabled={pending || next == null}
                onClick={() => void load(next!)}
              >
                {t('workflowCanvas.next')}
              </Button>
            </div>
          )}
          {preview && (
            <div
              data-testid="workflow-run-archive-preview-result"
              className="my-3 space-y-2 text-sm"
            >
              <p>
                {t('workflowRunArchive.capacity', {
                  count: preview.activeRecords,
                  limit: preview.maximumRecords,
                  bytes: preview.observationBytes,
                  maximum: preview.maximumObservationBytes,
                })}
              </p>
              <p>{t('workflowRunArchive.release', { bytes: preview.releasableBytes })}</p>
              {preview.entries
                .filter(entry => entry.blockers.length)
                .map(entry => (
                  <p key={entry.runId} className="break-words text-destructive" role="alert">
                    {entry.runId}:{' '}
                    {entry.blockers
                      .map(blocker => t(`workflowRunArchive.blocker_${blocker}`, blocker))
                      .join(' · ')}
                  </p>
                ))}
            </div>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              data-testid="workflow-run-archive-cancel"
              disabled={pending}
              onClick={close}
            >
              {t('workflowRunArchive.cancel')}
            </Button>
            <Button
              variant="secondary"
              data-testid="workflow-run-archive-preview"
              disabled={pending || archived || !selected.length}
              onClick={() => void inspect()}
            >
              {t('workflowRunArchive.preview')}
            </Button>
            {preview && (
              <Button
                data-testid="workflow-run-archive-confirm"
                disabled={
                  pending ||
                  !selected.length ||
                  preview.entries.some(entry => entry.blockers.length)
                }
                onClick={() => void confirm()}
              >
                {t('workflowRunArchive.confirm')}
              </Button>
            )}
          </div>
        </ModalDialog>
      )}
    </>
  )
}
