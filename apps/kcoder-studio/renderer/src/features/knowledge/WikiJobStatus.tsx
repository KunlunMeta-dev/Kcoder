import { downloadLink } from '@/kcoder/downloadLink'
import { FrozenModelConfigurationDetails } from '@/components/chat/composer/FrozenModelConfigurationDetails'
import { useEffect, useState } from 'react'
import { Download, Info } from 'lucide-react'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { wikiJobDiagnostic, wikiJobPhase, type WikiObservedJob } from './wikiJobProgress'
import { readableWikiPipeline } from './wikiPipeline'
import {
  WikiPipelineDetails,
  WikiPipelineProgress,
  WikiPipelineSummary,
} from './WikiPipelineProgress'

export function WikiJobStatus({
  job,
  disconnected,
}: {
  job: WikiObservedJob
  disconnected: boolean
}) {
  const { t } = useTranslation('knowledge')
  const phase = wikiJobPhase(job)
  const pipeline = phase !== 'unknown' ? readableWikiPipeline(job) : undefined
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (job.status !== 'running' || phase === 'unknown') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [job.status, phase])
  const [detailsOpen, setDetailsOpen] = useState(false)
  const progress = job.progress
  const exportDiagnostic = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(wikiJobDiagnostic(job), null, 2)], { type: 'application/json' })
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `wiki-job-${job.id}.json`
    downloadLink(anchor)
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" data-testid="wiki-job-status">
      <div className="min-w-0 flex-1">
        {pipeline ? (
          <WikiPipelineSummary job={job} now={now} disconnected={disconnected} />
        ) : (
          <p aria-live="polite">
            {t(`jobPhase.${phase}`, {
              defaultValue: t(`jobStatus.${job.status}`, { defaultValue: t('jobPhase.unknown') }),
            })}
            {progress?.firstPage != null && progress?.lastPage != null && (
              <> · {t('jobPageRange', { first: progress.firstPage, last: progress.lastPage })}</>
            )}
            {progress && (
              <>
                {' '}
                ·{' '}
                {t('jobElapsed', {
                  minutes: Math.max(0, Math.floor((now - progress.startedAtMs) / 60000)),
                })}
              </>
            )}
          </p>
        )}
        {pipeline && <WikiPipelineProgress job={job} disconnected={disconnected} />}
        {disconnected && job.status !== 'running' && (
          <p className="mt-1 text-text-muted">{t('jobConnectionLost')}</p>
        )}
        {job.status === 'running' && phase !== 'unknown' && (
          <p className="text-text-muted">
            {disconnected
              ? t('jobConnectionLost')
              : !pipeline &&
                  progress &&
                  now - Math.max(progress.modelProgressAtMs ?? 0, progress.phaseStartedAtMs) > 30000
                ? t('jobWaitingForModel')
                : null}
          </p>
        )}
      </div>
      {!pipeline && progress?.totalChunks != null && progress.totalChunks > 0 && (
        <span className="hidden shrink-0 tabular-nums text-text-muted sm:block">
          {Math.min(job.afterChunk, progress.totalChunks)} / {progress.totalChunks}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 max-md:min-h-11 max-md:min-w-11"
        aria-label={t('jobDetails')}
        data-testid="wiki-job-details"
        onClick={() => setDetailsOpen(true)}
      >
        <Info />
      </Button>
      {detailsOpen && (
        <ModalDialog
          title={t('jobDetails')}
          onClose={() => setDetailsOpen(false)}
          closeLabel={t('close')}
          testId="wiki-job-details-dialog"
        >
          <div className="max-h-[65vh] space-y-3 overflow-y-auto py-4 text-sm text-text-secondary">
            <WikiPipelineDetails job={job} />
            <details
              open={pipeline ? undefined : true}
              className="space-y-3"
              data-testid="wiki-job-diagnostics"
            >
              <summary className="w-fit cursor-pointer text-sm text-text-secondary">
                {t('pipeline.diagnostics')}
              </summary>
              {progress && (
                <>
                  <section className="space-y-3 border-b border-border/50 pb-4">
                    <h3 className="text-sm font-medium text-text-primary">
                      {t('jobModelSection')}
                    </h3>
                    <p>
                      {t('jobModel', {
                        model: progress.model,
                        effort: progress.reasoningEffort ?? t('jobInherit'),
                      })}
                    </p>
                    <FrozenModelConfigurationDetails configuration={progress.modelConfiguration} />
                  </section>
                  <section className="space-y-3 border-b border-border/50 pb-4">
                    <h3 className="text-sm font-medium text-text-primary">
                      {t('jobProgressSection')}
                    </h3>
                    <p>
                      {t('jobChunks', {
                        completed: job.afterChunk,
                        total: progress.totalChunks ?? t('jobUnknown'),
                      })}
                    </p>
                    <p>
                      {t('jobCalls', {
                        calls: progress.reservedCalls,
                        repairs: progress.repairCalls,
                      })}
                      {progress.callLimit != null && (
                        <> · {t('jobCallLimit', { limit: progress.callLimit })}</>
                      )}
                    </p>
                    {progress.requestedOutputTokens != null && (
                      <p>{t('jobOutputBudget', { tokens: progress.requestedOutputTokens })}</p>
                    )}
                    <p>
                      {progress.inputTokens != null && progress.outputTokens != null
                        ? t('jobUsage', {
                            input: progress.inputTokens,
                            output: progress.outputTokens,
                            reported: progress.usageReportedCalls,
                            calls: progress.reservedCalls,
                          })
                        : t('jobUsageUnknown')}
                    </p>
                  </section>
                  <section className="space-y-3">
                    <h3 className="text-sm font-medium text-text-primary">
                      {t('jobConnectionSection')}
                    </h3>
                    <p>
                      {t('jobHeartbeat', {
                        seconds: Math.max(0, Math.floor((now - progress.heartbeatAtMs) / 1000)),
                      })}
                    </p>
                    <p>
                      {progress.modelProgressAtMs != null
                        ? t('jobModelActivity', {
                            seconds: Math.max(
                              0,
                              Math.floor((now - progress.modelProgressAtMs) / 1000)
                            ),
                            text: progress.textBytes,
                            reasoning: progress.reasoningBytes,
                          })
                        : t('jobNoModelActivity')}
                    </p>
                  </section>
                </>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="max-md:min-h-11"
                onClick={exportDiagnostic}
              >
                <Download />
                {t('jobExportDiagnostic')}
              </Button>
            </details>
          </div>
        </ModalDialog>
      )}
    </div>
  )
}
