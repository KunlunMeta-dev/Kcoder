import { useTranslation } from '@/hooks/useTranslation'
import type { WikiJob } from '@/kcoder/knowledgeApi'
import { knownWikiCount } from './wikiPipeline'
import { readableWikiOutcome, wikiJobNoticeKey, wikiUnverifiedTotal } from './wikiVerification'

/**
 * Committed outcome counts. Unverified units are listed by kind and never
 * folded into the verified count; zero-valued follow-ups stay hidden inline.
 */
export function WikiJobOutcomeSummary({ job }: { job: WikiJob }) {
  const { t } = useTranslation('knowledge')
  const outcome = readableWikiOutcome(job.outcome)
  if (!outcome) return null
  const unverified = wikiUnverifiedTotal(outcome)
  const kinds = (['unsupported', 'uncertain', 'unassessed'] as const)
    .filter(kind => outcome.unverified[kind] > 0)
    .map(kind => `${t(`verification.verdict.${kind}`)} ${outcome.unverified[kind]}`)
    .join(' · ')
  return (
    // A span keeps the summary valid inside row buttons.
    <span
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs font-normal text-text-muted"
      data-testid="wiki-job-outcome"
    >
      <span>{t('outcome.published', { count: outcome.publishedPages })}</span>
      <span>{t('outcome.verified', { count: outcome.verifiedUnits })}</span>
      {unverified > 0 && (
        <span className="text-warning" title={kinds} data-testid="wiki-job-outcome-unverified">
          {t('outcome.unverified', { count: unverified })}
        </span>
      )}
      {outcome.pendingUnits > 0 && (
        <span data-testid="wiki-job-outcome-pending">
          {t('outcome.pending', { count: outcome.pendingUnits })}
        </span>
      )}
      {outcome.withheldUpdates > 0 && (
        <span data-testid="wiki-job-outcome-withheld">
          {t('outcome.withheld', { count: outcome.withheldUpdates })}
        </span>
      )}
    </span>
  )
}

/** Full outcome for the task details dialog. */
export function WikiJobOutcomeDetails({ job }: { job: WikiJob }) {
  const { t } = useTranslation('knowledge')
  const outcome = readableWikiOutcome(job.outcome)
  if (!outcome) return null
  const rows: Array<[string, number]> = [
    ['outcome.publishedLabel', outcome.publishedPages],
    ['outcome.verifiedLabel', outcome.verifiedUnits],
    ['verification.verdict.unsupported', outcome.unverified.unsupported],
    ['verification.verdict.uncertain', outcome.unverified.uncertain],
    ['verification.verdict.unassessed', outcome.unverified.unassessed],
    ['outcome.pendingLabel', outcome.pendingUnits],
    ['outcome.withheldLabel', outcome.withheldUpdates],
  ]
  return (
    <section
      className="space-y-3 border-b border-border/50 pb-4"
      data-testid="wiki-job-outcome-details"
    >
      <h3 className="text-sm font-medium text-text-primary">{t('outcome.title')}</h3>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        {rows.map(([key, value]) => (
          <div key={key} className="contents">
            <dt>{t(key)}</dt>
            <dd className="text-right tabular-nums text-text-primary">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-text-muted">{t('outcome.hint')}</p>
    </section>
  )
}

/** Tool-loop counters are diagnostics; they stay inside the collapsed area. */
export function WikiJobToolDiagnostics({ job }: { job: WikiJob }) {
  const { t } = useTranslation('knowledge')
  const outcome = readableWikiOutcome(job.outcome)
  const progress = job.progress
  const current =
    knownWikiCount(progress?.toolTurns) || knownWikiCount(progress?.toolCalls)
      ? {
          turns: knownWikiCount(progress?.toolTurns) ? progress.toolTurns : t('jobUnknown'),
          calls: knownWikiCount(progress?.toolCalls) ? progress.toolCalls : t('jobUnknown'),
        }
      : undefined
  const committed =
    outcome && knownWikiCount(outcome.toolTurns) && knownWikiCount(outcome.toolCalls)
      ? { turns: outcome.toolTurns, calls: outcome.toolCalls }
      : undefined
  if (!current && !committed) return null
  return (
    <section className="space-y-2 border-b border-border/50 pb-4" data-testid="wiki-job-tools">
      <h3 className="text-sm font-medium text-text-primary">{t('toolLoop.title')}</h3>
      {current && <p>{t('toolLoop.current', current)}</p>}
      {committed && <p>{t('toolLoop.committed', committed)}</p>}
    </section>
  )
}

export function WikiJobNotice({ job }: { job: WikiJob }) {
  const { t } = useTranslation('knowledge')
  const key = wikiJobNoticeKey(job.notice)
  if (!key) return null
  return (
    <p className="text-text-muted" data-testid="wiki-job-notice">
      {t(key)}
    </p>
  )
}
