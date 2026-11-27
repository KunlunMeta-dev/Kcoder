import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import {
  knowledgeApi,
  type WikiFindingDecision,
  type WikiVerificationFinding,
} from '@/kcoder/knowledgeApi'
import { WikiError } from './WikiError'
import {
  wikiDecisionFailure,
  wikiFindingCodeKey,
  wikiLineRangeLabel,
  wikiRequestKey,
  wikiVerdictKey,
} from './wikiVerification'

export type WikiFindingsScope =
  /** The reader's displayed revision is the decision precondition. */
  | { pageId: string; expectedRevision: string }
  /** Job lists decide each finding against the revision it is bound to. */
  | { jobId: string }

interface WikiVerificationFindingsProps {
  serverId: string
  libraryId: string
  scope: WikiFindingsScope
  isCurrent: () => boolean
  canDecide: boolean
  pageTitles?: Record<string, string>
  /** A decision changed the page's open findings; re-read the page. */
  onDecided?: (finding: WikiVerificationFinding) => void
  /** The host rejected a decision because the page moved on; reload it. */
  onPageChanged?: () => void
}

/**
 * Unverified ranges awaiting a human judgement. Decisions are append-only and
 * never edit page content; failures are never retried automatically.
 */
export function WikiVerificationFindings({
  serverId,
  libraryId,
  scope,
  isCurrent,
  canDecide,
  pageTitles,
  onDecided,
  onPageChanged,
}: WikiVerificationFindingsProps) {
  const { t } = useTranslation('knowledge')
  const [items, setItems] = useState<WikiVerificationFinding[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [deciding, setDeciding] = useState<{
    findingId: string
    decision: WikiFindingDecision
  } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  // A retry of the same decision reuses its key; any other decision gets a new one.
  const keys = useRef(new Map<string, { decision: WikiFindingDecision; key: string }>())
  const generation = useRef(0)
  const pageId = 'pageId' in scope ? scope.pageId : undefined
  const jobId = 'jobId' in scope ? scope.jobId : undefined
  const live = useCallback(
    (attempt: number) => isCurrent() && attempt === generation.current,
    [isCurrent]
  )
  const load = useCallback(
    async (afterId?: string) => {
      const attempt = afterId ? generation.current : ++generation.current
      setLoading(true)
      try {
        const result = await knowledgeApi.findings(serverId, libraryId, {
          pageId,
          jobId,
          afterId,
        })
        if (!live(attempt)) return
        const page = result.supported === false ? [] : result.items
        setItems(previous => (afterId ? [...previous, ...page] : page))
        setCursor(result.supported === false ? null : (result.nextAfterId ?? null))
      } catch (cause) {
        if (live(attempt)) setError(String(cause instanceof Error ? cause.message : cause))
      } finally {
        if (live(attempt)) setLoading(false)
      }
    },
    [serverId, libraryId, pageId, jobId, live]
  )
  useEffect(() => {
    let active = true
    const lifetime = generation
    queueMicrotask(() => {
      if (active) void load()
    })
    return () => {
      active = false
      ++lifetime.current
    }
  }, [load, reload])

  const decide = async (finding: WikiVerificationFinding, decision: WikiFindingDecision) => {
    const expectedRevision =
      'expectedRevision' in scope ? scope.expectedRevision : finding.revisionId
    const previous = keys.current.get(finding.findingId)
    const key =
      previous?.decision === decision ? previous.key : wikiRequestKey(`finding:${decision}`)
    keys.current.set(finding.findingId, { decision, key })
    const attempt = generation.current
    setDeciding({ findingId: finding.findingId, decision })
    setError('')
    setNotice('')
    try {
      const decided = await knowledgeApi.decideFinding(
        serverId,
        libraryId,
        finding,
        expectedRevision,
        decision,
        key
      )
      keys.current.delete(finding.findingId)
      if (!live(attempt)) return
      setItems(current => current.filter(item => item.findingId !== decided.findingId))
      setNotice(t(decision === 'confirm' ? 'findings.confirmed' : 'findings.dismissed'))
      onDecided?.(decided)
    } catch (cause) {
      const failure = wikiDecisionFailure(cause)
      // Rejected preconditions are final for this key; only an unknown or
      // transport failure keeps it for an explicit retry of the same choice.
      if (failure !== 'other') keys.current.delete(finding.findingId)
      if (!live(attempt)) return
      if (failure === 'pageChanged') {
        setNotice(t('findings.pageChanged'))
        setReload(value => value + 1)
        onPageChanged?.()
      } else if (failure === 'idempotencyConflict') {
        setNotice(t('findings.conflict'))
        setReload(value => value + 1)
      } else setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      if (live(attempt)) setDeciding(null)
    }
  }

  return (
    <section
      className="space-y-3 rounded-xl border border-border/60 bg-surface/30 p-4 text-sm"
      aria-label={t('findings.title')}
      aria-busy={loading || deciding !== null}
      data-testid="wiki-verification-findings"
    >
      <div className="space-y-1">
        <h3 className="font-medium text-text-primary">{t('findings.title')}</h3>
        <p className="text-xs text-text-muted">{t('findings.hint')}</p>
      </div>
      {notice && (
        <p role="status" className="text-xs text-text-secondary" data-testid="wiki-findings-notice">
          {notice}
        </p>
      )}
      {error && <WikiError error={error} />}
      {!loading && !items.length ? (
        <p className="text-text-muted" data-testid="wiki-findings-empty">
          {t('findings.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-border/40">
          {items.map(finding => (
            <li
              key={finding.findingId}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2"
              data-testid={`wiki-finding-${finding.findingId}`}
              data-verdict={finding.verdict}
            >
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="flex items-center gap-1.5 text-text-primary">
                  <CircleAlert className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
                  {t(wikiVerdictKey(finding.verdict))}
                  <span className="text-text-muted">· {wikiLineRangeLabel(finding, t)}</span>
                </span>
                <span className="block text-xs text-text-muted">
                  {jobId && <>{pageTitles?.[finding.pageId] ?? finding.pageId} · </>}
                  {t(wikiFindingCodeKey(finding.code))}
                </span>
              </span>
              <span className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="max-md:min-h-11"
                  disabled={!canDecide || deciding !== null || !finding.current}
                  data-testid={`wiki-finding-confirm-${finding.findingId}`}
                  onClick={() => void decide(finding, 'confirm')}
                >
                  {deciding?.findingId === finding.findingId && deciding.decision === 'confirm' && (
                    <LoaderCircle className="animate-spin" />
                  )}
                  {t('findings.confirm')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="max-md:min-h-11"
                  disabled={!canDecide || deciding !== null || !finding.current}
                  data-testid={`wiki-finding-dismiss-${finding.findingId}`}
                  onClick={() => void decide(finding, 'dismiss')}
                >
                  {deciding?.findingId === finding.findingId && deciding.decision === 'dismiss' && (
                    <LoaderCircle className="animate-spin" />
                  )}
                  {t('findings.dismiss')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {(loading || cursor) && (
        <Button
          size="sm"
          variant="ghost"
          className="max-md:min-h-11"
          disabled={loading}
          pending={loading}
          pendingLabel={t('loading')}
          data-testid="wiki-findings-more"
          onClick={() => cursor && void load(cursor)}
        >
          {t('more')}
        </Button>
      )}
    </section>
  )
}
