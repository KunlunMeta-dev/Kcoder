import { WikiImageImports } from './WikiImageImports'
import { WikiFileExtraction } from './WikiFileExtraction'
import { WikiFileImportControls } from './WikiFileImportControls'
import {
  wikiFileIssue,
  wikiBatchIssue,
  wikiFileCapabilities,
  type WikiFileCapability,
} from './wikiFileCapabilities'
import { WikiJobStatus } from './WikiJobStatus'
import { wikiJobRecovery, wikiJobResumeStage } from './wikiJobProgress'
import { runWikiBatch, type BatchEntry } from './wikiBatch'
import { WikiDirectoryImport } from './WikiDirectoryImport'
import { WikiError } from './WikiError'
import { WikiReviewDialog } from './WikiReviewDialog'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { LoaderCircle, Pause, Play, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeApi, type WikiJob, type WikiSource } from '@/kcoder/knowledgeApi'
import { startSnapshotPolling } from '@/lib/snapshotPolling'

export function WikiImport({
  serverId,
  libraryId,
  isCurrent,
  onChanged,
  sources,
  refreshSignal,
  canOrganize,
  onInspectSource,
  onJobsChanged,
  actions,
}: {
  serverId: string
  libraryId: string
  isCurrent: () => boolean
  onChanged: () => void
  sources: WikiSource[]
  refreshSignal: number
  canOrganize: boolean
  onInspectSource?: (source: WikiSource) => void
  onJobsChanged?: (jobs: WikiJob[], disconnected: boolean) => void
  actions?: ReactNode
}) {
  const { t, i18n } = useTranslation('knowledge')
  const alive = useRef(true)
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [capabilities, setCapabilities] = useState<WikiFileCapability[]>(wikiFileCapabilities)
  const [busy, setBusy] = useState(false)
  const [batch, setBatch] = useState<BatchEntry<File, WikiSource>[]>([])
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [finished, setFinished] = useState(false)
  const [reviewJob, setReviewJob] = useState<string | null>(null)
  const [jobs, setJobs] = useState<WikiJob[]>([])
  const previousJobs = useRef<WikiJob[] | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    void knowledgeApi
      .fileCapabilities(serverId)
      .then(result => {
        if (active && isCurrent() && result.supported !== false) setCapabilities(result.items)
      })
      .catch(() => {
        /* Older targets keep the explicit Wiki v1 fallback. */
      })
    return () => {
      active = false
    }
  }, [serverId, isCurrent])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    return startSnapshotPolling({
      isCurrent,
      retryDelayMs: 2000,
      poll: async (isLive, signal) => {
        const result = await knowledgeApi.jobs(serverId, libraryId, isLive, signal)
        if (!isLive()) return false
        const changed =
          previousJobs.current !== null &&
          result.items.some(
            job =>
              job.status === 'completed' &&
              previousJobs.current?.find(previous => previous.id === job.id)?.status !== 'completed'
          )
        setPollError('')
        previousJobs.current = result.items
        setJobs(result.items)
        onJobsChanged?.(result.items, false)
        if (changed) {
          setFinished(true)
          onChanged()
        }
        return result.items.some(job => ['running', 'queued'].includes(job.status)) ? 2000 : 15000
      },
      onError: cause => {
        setPollError(String(cause instanceof Error ? cause.message : cause))
        onJobsChanged?.(previousJobs.current ?? [], true)
      },
    })
  }, [serverId, libraryId, isCurrent, onChanged, onJobsChanged, refresh, refreshSignal])
  const processBatch = async (entries: BatchEntry<File, WikiSource>[]) => {
    setBusy(true)
    setError('')
    setFinished(false)
    try {
      await runWikiBatch(entries, {
        current: () => alive.current && isCurrent(),
        upload: async (file, retry) => {
          const issue = wikiFileIssue(file, capabilities)
          if (issue) throw new Error(t(issue, { name: file.name }))
          return knowledgeApi.importFile(
            serverId,
            libraryId,
            file,
            () => alive.current && isCurrent(),
            retry
          )
        },
        organize: source => knowledgeApi.startJob(serverId, libraryId, source, i18n.language),
        changed: entries => {
          setBatch(entries)
          onChanged()
          setRefresh(value => value + 1)
        },
      })
    } finally {
      if (alive.current && isCurrent()) setBusy(false)
    }
  }
  const importFiles = async (files: File[]) => {
    const issue = wikiBatchIssue(files, capabilities)
    if (issue) {
      setError(t(issue))
      return
    }
    await processBatch(files.map(item => ({ item, status: 'pending' })))
  }
  const sourceForJob = (job: WikiJob): WikiSource | undefined =>
    sources.find(source => source.sourceId === job.sourceId) ??
    // Jobs retain the identity needed to read a source outside the loaded catalog.
    (job.sourceRevision
      ? {
          sourceId: job.sourceId,
          revisionId: job.sourceRevision,
          title: job.sourceTitle ?? job.sourceId,
          bodyHash: '',
        }
      : undefined)
  const control = async (job: WikiJob) => {
    setBusy(true)
    setError('')
    try {
      if (['running', 'queued'].includes(job.status))
        await knowledgeApi.pauseJob(serverId, libraryId, job.id)
      else if (wikiJobRecovery(job) === 'reorganize') {
        const source = sourceForJob(job)
        if (!source || source.removed) throw new Error(t('errorUnavailable'))
        await knowledgeApi.startJob(
          serverId,
          libraryId,
          source,
          i18n.language,
          `reorganize:${job.id}`
        )
        await knowledgeApi.cancelJob(serverId, libraryId, job.id)
      } else {
        if (job.errorCode === 'budget_exceeded')
          await knowledgeApi.extendBudget(serverId, libraryId, job.id)
        await knowledgeApi.resumeJob(serverId, libraryId, job.id)
      }
    } catch (cause) {
      if (alive.current && isCurrent())
        setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      if (alive.current && isCurrent()) {
        setBusy(false)
        setRefresh(value => value + 1)
      }
    }
  }
  return (
    <div className="mb-4 shrink-0 space-y-3">
      <WikiFileImportControls
        actions={actions}
        busy={busy || !canOrganize}
        capabilities={capabilities}
        onFiles={files => void importFiles(files)}
        onDirectory={() => setDirectoryOpen(true)}
      />
      {batch.length > 0 && (
        <details className="space-y-2 rounded-lg bg-surface/30 p-3" aria-live="polite">
          <summary className="cursor-pointer text-xs text-text-secondary">
            {t('batchProgress', {
              done: batch.filter(entry => entry.status === 'queued').length,
              total: batch.length,
            })}
          </summary>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {batch.map((entry, index) => (
              <div key={index} className="text-xs">
                <div className="flex min-w-0 justify-between gap-3">
                  <span className="truncate" title={entry.item.name}>
                    {entry.item.name}
                  </span>
                  <span className="shrink-0 text-text-muted">
                    {t(`batchStatus.${entry.status}`)}
                  </span>
                </div>
                {entry.source?.extraction && (
                  <WikiFileExtraction report={entry.source.extraction} />
                )}
                {entry.error && <WikiError error={`${entry.item.name}: ${entry.error}`} />}
              </div>
            ))}
          </div>
          {batch.some(entry => entry.status === 'failed') && (
            <Button
              size="sm"
              variant="outline"
              className="max-md:min-h-11"
              disabled={busy || !canOrganize}
              data-testid="wiki-batch-retry"
              onClick={() => void processBatch(batch)}
            >
              {t('retryBatch')}
            </Button>
          )}
        </details>
      )}
      <WikiImageImports
        serverId={serverId}
        libraryId={libraryId}
        isCurrent={isCurrent}
        canOrganize={canOrganize}
        refreshSignal={refresh + refreshSignal}
        onChanged={onChanged}
      />
      {finished && (
        <p role="status" className="text-xs text-text-muted">
          {t('organizationFinished')}
        </p>
      )}
      {pollError && (
        <p role="status" className="text-xs text-text-muted">
          {t('statusRetrying')}
        </p>
      )}
      {error && <WikiError error={error} />}
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {jobs
          .filter(job => !['completed', 'cancelled'].includes(job.status))
          .map(job => (
            <div
              key={job.id}
              data-testid={`wiki-job-row-${job.id}`}
              className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-border/50 bg-surface/30 px-3 py-2 text-xs text-text-secondary"
            >
              {job.status === 'running' && !pollError && (
                <LoaderCircle className="size-3 animate-spin" />
              )}
              <span className="w-full min-w-0 truncate font-medium text-text-primary sm:w-48">
                {job.sourceTitle ??
                  sources.find(source => source.sourceId === job.sourceId)?.title ??
                  t('organizing')}
              </span>
              <WikiJobStatus job={job} disconnected={Boolean(pollError)} />
              {(job.errorCode ||
                (job.status === 'awaiting_review' && job.reviewAvailable === false)) && (
                <span className="basis-full text-text-muted">
                  {t(
                    `jobErrors.${job.status === 'awaiting_review' && job.reviewAvailable === false ? 'review_required_without_candidate' : job.errorCode}`,
                    {
                      defaultValue: t('jobError'),
                    }
                  )}
                </span>
              )}
              {onInspectSource &&
                ['invalid_evidence', 'repair_budget_exceeded', 'model_output_truncated'].includes(
                  job.errorCode ?? ''
                ) && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="max-md:min-h-11"
                    data-testid="wiki-job-view-source"
                    disabled={!sourceForJob(job)}
                    onClick={() => {
                      const source = sourceForJob(job)
                      if (source) onInspectSource(source)
                    }}
                  >
                    {t('jobViewSource')}
                  </Button>
                )}
              {wikiJobRecovery(job) === 'review' && (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="wiki-review-open"
                  disabled={!canOrganize || Boolean(pollError)}
                  onClick={() => setReviewJob(job.id)}
                >
                  {t('viewSuggestion')}
                </Button>
              )}
              {['failed', 'paused'].includes(job.status) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || Boolean(pollError)}
                  aria-label={t('dismissTask')}
                  onClick={() => {
                    setBusy(true)
                    void knowledgeApi
                      .cancelJob(serverId, libraryId, job.id)
                      .then(() => {
                        if (alive.current && isCurrent()) setRefresh(value => value + 1)
                      })
                      .catch(cause => {
                        if (alive.current && isCurrent())
                          setError(String(cause instanceof Error ? cause.message : cause))
                      })
                      .finally(() => {
                        if (alive.current && isCurrent()) setBusy(false)
                      })
                  }}
                >
                  <X />
                </Button>
              )}
              {!['review', 'unavailable'].includes(wikiJobRecovery(job)) && (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="wiki-job-control"
                  disabled={busy || !canOrganize || Boolean(pollError)}
                  onClick={() => void control(job)}
                >
                  {['running', 'queued'].includes(job.status) ? (
                    <>
                      <Pause />
                      {t('pause')}
                    </>
                  ) : (
                    <>
                      <Play />
                      {wikiJobResumeStage(job)
                        ? t('pipeline.resume', {
                            stage: t(`pipeline.stage.${wikiJobResumeStage(job)!.stage}`),
                          })
                        : t(
                            wikiJobRecovery(job) === 'reorganize'
                              ? 'jobReorganize'
                              : job.errorCode === 'budget_exceeded'
                                ? 'extendAndResume'
                                : job.status === 'failed'
                                  ? 'jobRetry'
                                  : 'resume'
                          )}
                    </>
                  )}
                </Button>
              )}
            </div>
          ))}
      </div>
      {directoryOpen && canOrganize && (
        <WikiDirectoryImport
          serverId={serverId}
          libraryId={libraryId}
          isCurrent={isCurrent}
          onChanged={onChanged}
          onClose={() => setDirectoryOpen(false)}
        />
      )}
      {reviewJob && (
        <WikiReviewDialog
          serverId={serverId}
          libraryId={libraryId}
          jobId={reviewJob}
          isCurrent={isCurrent}
          onClose={() => setReviewJob(null)}
          onResolved={job => {
            onChanged()
            setRefresh(value => value + 1)
            if (job.status === 'queued')
              void knowledgeApi
                .resumeJob(serverId, libraryId, job.id)
                .then(() => {
                  if (alive.current && isCurrent()) setRefresh(value => value + 1)
                })
                .catch(cause => {
                  if (alive.current && isCurrent())
                    setError(String(cause instanceof Error ? cause.message : cause))
                })
          }}
        />
      )}
    </div>
  )
}
