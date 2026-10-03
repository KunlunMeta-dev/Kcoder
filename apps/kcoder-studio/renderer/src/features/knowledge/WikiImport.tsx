import { runWikiBatch, type BatchEntry } from './wikiBatch'
import { WikiDirectoryImport } from './WikiDirectoryImport'
import { WikiError } from './WikiError'
import { WikiReviewDialog } from './WikiReviewDialog'
import { useEffect, useRef, useState } from 'react'
import { FilePlus2, FolderOpen, LoaderCircle, Pause, Play, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeApi, type WikiJob, type WikiSource } from '@/kcoder/knowledgeApi'

export function WikiImport({
  serverId,
  libraryId,
  isCurrent,
  onChanged,
  sources,
  refreshSignal,
  canOrganize,
}: {
  serverId: string
  libraryId: string
  isCurrent: () => boolean
  onChanged: () => void
  sources: WikiSource[]
  refreshSignal: number
  canOrganize: boolean
}) {
  const { t, i18n } = useTranslation('knowledge')
  const picker = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [batch, setBatch] = useState<BatchEntry<File, WikiSource>[]>([])
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [finished, setFinished] = useState(false)
  const [reviewJob, setReviewJob] = useState<string | null>(null)
  const [jobs, setJobs] = useState<WikiJob[]>([])
  const previousJobs = useRef<WikiJob[]>([])
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const poll = async () => {
      try {
        const result = await knowledgeApi.jobs(serverId, libraryId)
        if (!active || !isCurrent()) return
        const changed = result.items.some(
          job =>
            job.status === 'completed' &&
            previousJobs.current.find(previous => previous.id === job.id)?.status !== 'completed'
        )
        failures = 0
        setPollError('')
        previousJobs.current = result.items
        setJobs(result.items)
        if (changed) {
          setFinished(true)
          onChanged()
        }
        if (result.items.some(job => ['running', 'queued'].includes(job.status)))
          timer = setTimeout(() => void poll(), 2000)
      } catch (cause) {
        if (active && isCurrent()) {
          setPollError(String(cause instanceof Error ? cause.message : cause))
          failures += 1
          timer = setTimeout(
            () => void poll(),
            Math.min(2000 * 2 ** Math.min(failures - 1, 4), 30000)
          )
        }
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [serverId, libraryId, isCurrent, onChanged, refresh, refreshSignal])
  const processBatch = async (entries: BatchEntry<File, WikiSource>[]) => {
    setBusy(true)
    setError('')
    setFinished(false)
    try {
      await runWikiBatch(entries, {
        current: () => alive.current && isCurrent(),
        upload: async file => {
          const image = /\.(png|jpg|jpeg|webp)$/i.test(file.name)
          if (
            !/\.(txt|md|html|htm|pdf|docx|xlsx|pptx|png|jpg|jpeg|webp)$/i.test(file.name) ||
            file.size > (image ? 10 : 32) * 1024 * 1024
          )
            throw new Error(t(image ? 'imageLimit' : 'textLimit', { name: file.name }))
          return knowledgeApi.importFile(
            serverId,
            libraryId,
            file,
            () => alive.current && isCurrent()
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
    if (files.length > 10 || files.reduce((sum, file) => sum + file.size, 0) > 128 * 1024 * 1024) {
      setError(t('batchLimit'))
      return
    }
    await processBatch(files.map(item => ({ item, status: 'pending' })))
  }
  const control = async (job: WikiJob) => {
    setBusy(true)
    setError('')
    try {
      if (['running', 'queued'].includes(job.status))
        await knowledgeApi.pauseJob(serverId, libraryId, job.id)
      else {
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
    <div className="mb-5 shrink-0 space-y-2">
      <input
        data-testid="wiki-import-files"
        ref={picker}
        type="file"
        accept=".txt,.md,.html,.htm,.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.webp"
        multiple
        className="hidden"
        aria-label={t('importText')}
        onChange={event => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length) void importFiles(files)
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          className="max-md:min-h-11"
          disabled={busy || !canOrganize}
          data-testid="wiki-import-text"
          onClick={() => picker.current?.click()}
        >
          {busy ? <LoaderCircle className="animate-spin" /> : <FilePlus2 />}
          {t('importText')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || !canOrganize}
          data-testid="wiki-import-directory"
          onClick={() => setDirectoryOpen(true)}
        >
          <FolderOpen />
          {t('importDirectory')}
        </Button>
        <span className="text-xs text-text-muted">{t('importHint')}</span>
      </div>
      {batch.length > 0 && (
        <div className="space-y-2 rounded-lg border border-border p-3" aria-live="polite">
          <p className="text-xs text-text-secondary">
            {t('batchProgress', {
              done: batch.filter(entry => entry.status === 'queued').length,
              total: batch.length,
            })}
          </p>
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
              onClick={() => void processBatch(batch)}
            >
              {t('retryBatch')}
            </Button>
          )}
        </div>
      )}
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
      {jobs
        .filter(job => !['completed', 'cancelled'].includes(job.status))
        .map(job => (
          <div
            key={job.id}
            className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-text-secondary"
          >
            {job.status === 'running' && <LoaderCircle className="size-3 animate-spin" />}
            <span className="max-w-xs truncate">
              {sources.find(source => source.sourceId === job.sourceId)?.title ?? t('organizing')}
            </span>
            <span>{t(`jobStatus.${job.status}`, { defaultValue: t('loading') })}</span>
            {job.errorCode && (
              <span className="basis-full text-text-muted">
                {t(`jobErrors.${job.errorCode}`, { defaultValue: t('jobError') })}
              </span>
            )}
            {job.status === 'awaiting_review' && (
              <Button
                variant="outline"
                size="sm"
                data-testid="wiki-review-open"
                disabled={!canOrganize}
                onClick={() => setReviewJob(job.id)}
              >
                {t('viewSuggestion')}
              </Button>
            )}
            {['failed', 'paused'].includes(job.status) && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
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
            {job.status !== 'awaiting_review' && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !canOrganize}
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
                    {t(job.errorCode === 'budget_exceeded' ? 'extendAndResume' : 'resume')}
                  </>
                )}
              </Button>
            )}
          </div>
        ))}
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
