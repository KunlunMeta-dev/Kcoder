import { CircleAlert, CircleCheck, Info } from 'lucide-react'
import { AssistantMarkdown } from '@/components/chat/AssistantMarkdown'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { WikiPageUnverifiedLines } from '@/kcoder/knowledgeApi'
import { cn } from '@/lib/utils'
import {
  wikiLineRangeLabel,
  wikiVerdictKey,
  wikiVerificationSegments,
  type wikiVerificationView,
} from './wikiVerification'
import { StableLabel } from '@/components/ui/stable-content'

type VerificationView = NonNullable<ReturnType<typeof wikiVerificationView>>

/**
 * Page-level verification state. Verified uses the semantic success color;
 * legacy and human-edited pages are neutral facts, never warnings.
 */
export function WikiVerificationStatus({
  view,
  findingsOpen,
  onToggleFindings,
}: {
  view: VerificationView
  findingsOpen: boolean
  onToggleFindings?: () => void
}) {
  const { t } = useTranslation('knowledge')
  if (view.tone === 'warning')
    return (
      <div
        role="status"
        className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
        data-testid="wiki-verification-banner"
        data-status={view.status}
      >
        <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-text-primary">
            {view.status === 'partial'
              ? t('verification.partialBanner', { count: view.ranges.length })
              : t('verification.unassessedBanner')}
          </span>
          <span className="block text-xs text-text-secondary">{t('verification.bannerHint')}</span>
        </span>
        {onToggleFindings && (
          <Button
            size="sm"
            variant="ghost"
            className="max-md:min-h-11"
            aria-expanded={findingsOpen}
            data-testid="wiki-verification-findings-toggle"
            onClick={onToggleFindings}
          >
            <StableLabel alternatives={[t('verification.hideFindings'), t('verification.showFindings')]}>{t(findingsOpen ? 'verification.hideFindings' : 'verification.showFindings')}</StableLabel>
          </Button>
        )}
      </div>
    )
  const Icon = view.tone === 'success' ? CircleCheck : Info
  return (
    <p
      className={cn(
        'mb-3 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs',
        view.tone === 'success' ? 'bg-success/10 text-success' : 'bg-surface text-text-muted'
      )}
      data-testid="wiki-verification-status"
      data-status={view.status}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {t(`verification.status.${view.status}`)}
    </p>
  )
}

/** Renders the page body with unverified line ranges marked block by block. */
export function WikiVerifiedMarkdown({
  markdown,
  ranges,
  lineOffset,
}: {
  markdown: string
  ranges: WikiPageUnverifiedLines[]
  lineOffset: number
}) {
  const { t } = useTranslation('knowledge')
  const segments = wikiVerificationSegments(markdown, ranges, lineOffset)
  if (segments.length === 1 && !segments[0].ranges.length)
    return <AssistantMarkdown content={markdown} />
  return (
    <div className="space-y-4">
      {segments.map((segment, index) => {
        if (!segment.ranges.length)
          return <AssistantMarkdown key={index} content={segment.markdown} />
        const verdicts = [...new Set(segment.ranges.map(range => t(wikiVerdictKey(range.verdict))))]
        const label = segment.ranges
          .map(range => `${t(wikiVerdictKey(range.verdict))} · ${wikiLineRangeLabel(range, t)}`)
          .join('; ')
        return (
          <div
            key={index}
            tabIndex={0}
            title={label}
            aria-label={t('verification.rangeLabel', { detail: label })}
            className="rounded-r-lg border-l-2 border-warning/60 bg-warning/10 py-1 pl-3 pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
            data-testid="wiki-unverified-range"
            data-verdicts={segment.ranges.map(range => range.verdict).join(' ')}
          >
            <p
              className="mb-1 flex items-center gap-1 text-xs text-text-secondary"
              aria-hidden="true"
            >
              <CircleAlert className="size-3 text-warning" />
              {verdicts.join(' · ')}
            </p>
            <AssistantMarkdown content={segment.markdown} />
          </div>
        )
      })}
    </div>
  )
}
