import type { WorkspaceFileOpenOptions } from '@/types/workspace-files'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { TurnReviewEvidence, ReviewToolExecution } from '../../../../shared/generated/contracts'

export function NativeReviewEvidence({ evidence, onOpenFile, onAddToDraft }: {
  evidence: TurnReviewEvidence
  onOpenFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  onAddToDraft?: (text: string) => void
}) {
  const { t, i18n } = useTranslation('chat')
  const [page, setPage] = useState(0)
  const entries = [...evidence.observations].sort((a, b) => a.ordinal - b.ordinal)
  const lastPage = Math.max(0, Math.ceil(entries.length / 10) - 1)
  const currentPage = Math.min(page, lastPage)
  const failures = entries.filter(entry => entry.toolFailed || entry.outcome === 'denied' ||
    (entry.process && (entry.process.signal != null || (entry.process.exitCode != null && entry.process.exitCode !== 0))) ||
    entry.validation?.entries.some(check => !['passed', 'skipped_missing', 'unavailable'].includes(check.status))).length
  const format = (ms: number) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'medium' }).format(ms)
  const outcome = (entry: ReviewToolExecution) => {
    if (entry.outcome !== 'recorded') return t(`reviewEvidence.outcomes.${entry.outcome}`)
    if (entry.process?.signal != null) return t('reviewEvidence.signal', { signal: entry.process.signal })
    if (entry.process?.exitCode != null) return t('reviewEvidence.exit', { code: entry.process.exitCode })
    if (entry.process) return t('reviewEvidence.processUnknown')
    return t(entry.toolFailed ? 'reviewEvidence.toolFailed' : 'reviewEvidence.received')
  }
  return <section className="min-w-0 space-y-2" data-testid="native-review-evidence" aria-label={t('reviewEvidence.title')}>
    <p>{t('reviewEvidence.title')}</p>
    {failures > 0 && <p role="status" data-testid="native-review-failures">{t('reviewEvidence.failures', { count: failures })}</p>}
    {evidence.state !== 'settled' && <p role="status" data-testid="native-review-incomplete">{t(`reviewEvidence.states.${evidence.state}`)}</p>}
    {evidence.omittedCount > 0 && <p role="status">{t('reviewEvidence.omitted')}</p>}
    <p className="text-xs text-text-muted">{t('reviewEvidence.scope')}</p>
    {!entries.some(entry => entry.process || entry.validation) && <p data-testid="native-review-unverified">{t('reviewEvidence.unverified')}</p>}
    {entries.length === 0 && <p>{t('reviewEvidence.empty')}</p>}
    <ol className="min-w-0 space-y-3">
      {entries.slice(currentPage * 10, (currentPage + 1) * 10).map(entry => {
        const checks = entry.validation?.entries ?? []
        const passed = checks.filter(c => c.status === 'passed').length
        const unchecked = checks.filter(c => ['unavailable', 'skipped_missing'].includes(c.status)).length
        const failed = checks.length - passed - unchecked
        return <li key={entry.ordinal} className="min-w-0 space-y-1" data-testid="native-review-entry">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{entry.toolName} · <span data-testid="native-review-outcome">{outcome(entry)}</span></span>
            {onAddToDraft && <Button variant="ghost" size="sm" className="min-h-11 md:min-h-8" data-testid="native-review-feedback" onClick={() => onAddToDraft(`${t('taskReview.feedbackContext')}\n${JSON.stringify({ evidenceId: evidence.evidenceId, threadId: evidence.threadId, turnId: evidence.turnId, attemptId: evidence.attemptId, ordinal: entry.ordinal, toolCallId: entry.toolCallId, command: entry.command, outcome: entry.outcome, process: entry.process, artifacts: entry.artifacts, validation: entry.validation })}\n\n${t('taskReview.feedbackPrompt')}`)}>{t('taskReview.requestChanges')}</Button>}
          </div>
          {entry.command && <code className="block truncate text-xs" title={entry.command}>{entry.command}</code>}
          {entry.resultObservedAtMs != null && <p className="text-xs text-text-muted">{t('reviewEvidence.recorded')} <time dateTime={new Date(entry.resultObservedAtMs).toISOString()}>{format(entry.resultObservedAtMs)}</time></p>}
          {entry.validation && <p role="status" data-testid="native-review-check-summary">{t('reviewEvidence.checkSummary', { passed, failed, unchecked })}</p>}
          {entry.artifacts.map(file => <div key={file.path} className="min-w-0">
            {onOpenFile ? <Button variant="ghost" size="sm" className="min-h-11 max-w-full justify-start md:min-h-8" data-testid="native-review-open-artifact" title={file.path} onClick={() => onOpenFile(file.path, { sourceRevision: `sha256:${file.sha256}` })}><span className="truncate">{file.path}</span></Button> : <span className="break-all text-xs">{file.path}</span>}
          </div>)}
          <details>
            <summary data-testid="native-review-details" className="min-h-11 cursor-pointer rounded py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 md:min-h-8 md:py-1">{t('reviewEvidence.details')}</summary>
            <div className="min-w-0 space-y-2 text-xs">
              {entry.command && <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words">{entry.command}</pre>}
              {entry.process && <p className="break-all">{t('reviewEvidence.cwd', { path: entry.process.cwd })}</p>}
              {entry.executionObservedAtMs != null && <p>{t('reviewEvidence.executionObserved')} {format(entry.executionObservedAtMs)}</p>}
              {entry.detailsTruncated && <p role="status">{t('reviewEvidence.truncated')}</p>}
              {entry.artifacts.map(file => <p key={file.path} className="break-all">{t('reviewEvidence.writtenVersion', { path: file.path, sha256: file.sha256 })}</p>)}
              {entry.validation && <div className="space-y-1">
                <p>{t('reviewEvidence.checkedAt')} {format(entry.validation.observedAtMs)}</p>
                <p>{t('reviewEvidence.checkScope')}</p>
                {checks.map(check => <p key={check.index} className="break-all">{check.path} · {t(`reviewEvidence.checks.${check.status}`)}{check.sha256 ? ` · SHA-256 ${check.sha256}` : ''}</p>)}
              </div>}
              {entry.outputPreview && <pre data-testid="native-review-output" className="max-h-60 overflow-auto whitespace-pre-wrap break-words">{entry.outputPreview}</pre>}
            </div>
          </details>
        </li>
      })}
    </ol>
    {lastPage > 0 && <nav className="flex items-center gap-2" aria-label={t('reviewEvidence.pages')}>
      <Button variant="ghost" size="sm" className="min-h-11 md:min-h-8" data-testid="native-review-previous" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('taskReview.previous')}</Button>
      <span>{t('taskReview.page', { page: currentPage + 1, total: lastPage + 1 })}</span>
      <Button variant="ghost" size="sm" className="min-h-11 md:min-h-8" data-testid="native-review-next" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>{t('taskReview.next')}</Button>
    </nav>}
  </section>
}
