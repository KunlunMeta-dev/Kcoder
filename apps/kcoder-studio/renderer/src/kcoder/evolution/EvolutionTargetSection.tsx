import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusChip } from '@/components/settings/settings-ui'
import { StableLabel } from '@/components/ui/stable-content'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import {
  decideEvolutionProposal,
  distillEvolutionTarget,
  evolutionFailureKind,
  evolutionRejectionReason,
  readEvolutionSettings,
  readEvolutionTarget,
  saveEvolutionSettings,
  updateEvolutionOverlay,
  type EvolutionFailureKind,
} from './evolutionApi'
import type {
  EvolutionDecision,
  EvolutionOverlayContent,
  EvolutionProposalSummary,
  EvolutionTargetReadResult,
} from './evolutionContract'
import { subscribeEvolutionChanged } from './evolutionEvents'
import { formatScore, withItem } from './evolutionSettingsModel'
import { decisionLabelKey, proposalDecisions, targetDecisionRevision } from './evolutionTargetModel'

type SuccessKind =
  | 'saved'
  | 'decided.approve'
  | 'decided.promote'
  | 'decided.reject'
  | 'decided.rollback'
  | 'decided.pin_stable'
  | 'distill.queued'

interface Notice {
  kind: EvolutionFailureKind | SuccessKind | 'distill.disabled' | 'distill.unknown_target' | 'distill.model_unavailable'
  reason?: string | null
  /** Server notice accompanying a completed decision, e.g. files kept after a rollback. */
  warning?: string | null
}

const SUCCESS = new Set<string>([
  'saved',
  'decided.approve',
  'decided.promote',
  'decided.reject',
  'decided.rollback',
  'decided.pin_stable',
  'distill.queued',
])

/**
 * "Evolution" disclosure in an object's details. It reads nothing until opened
 * and every write carries the revision it last read.
 */
export function EvolutionTargetSection({
  deviceId,
  workspacePath,
  targetKey,
  isScopeCurrent = () => true,
}: {
  deviceId: string
  workspacePath?: string
  targetKey: string
  isScopeCurrent?: () => boolean
}) {
  const { t, i18n } = useTranslation('evolution')
  const [read, setRead] = useState<EvolutionTargetReadResult | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'missing' | 'failed'>('idle')
  const [draft, setDraft] = useState<EvolutionOverlayContent | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const generation = useRef(0)

  const load = useCallback(async () => {
    const ticket = ++generation.current
    setStatus('loading')
    try {
      const next = await readEvolutionTarget(deviceId, targetKey, workspacePath)
      if (ticket !== generation.current || !isScopeCurrent()) return
      setRead(next)
      setDraft(null)
      setStatus('ready')
    } catch (error) {
      if (ticket !== generation.current || !isScopeCurrent()) return
      setStatus(evolutionFailureKind(error) === 'not_found' ? 'missing' : 'failed')
    }
  }, [deviceId, isScopeCurrent, targetKey, workspacePath])

  // Proposal, promotion and rollback notifications for this object refetch the open section.
  const loaded = status !== 'idle'
  useEffect(() => {
    if (!loaded) return
    return subscribeEvolutionChanged(event => {
      if (event.deviceId !== deviceId) return
      if (event.targetKey && event.targetKey !== targetKey) return
      if (['proposal', 'promoted', 'rolled_back', 'cleared'].includes(event.reason)) void load()
    })
  }, [deviceId, load, loaded, targetKey])

  const run = async (key: string, action: () => Promise<Notice | void>) => {
    if (busy) return
    setBusy(key)
    setNotice(null)
    try {
      const outcome = await action()
      if (!isScopeCurrent()) return
      setNotice(outcome ?? { kind: 'saved' })
      await load()
    } catch (error) {
      if (!isScopeCurrent()) return
      setNotice({ kind: evolutionFailureKind(error, true), reason: evolutionRejectionReason(error) })
    } finally {
      if (isScopeCurrent()) setBusy(null)
    }
  }

  const decide = (proposal: EvolutionProposalSummary, decision: EvolutionDecision) =>
    read &&
    void run(`${proposal.id}:${decision}`, async () => {
      const result = await decideEvolutionProposal(deviceId, {
        ...(workspacePath ? { workspace: workspacePath } : {}),
        targetKey,
        proposalId: proposal.id,
        decision,
        expectedRevision: targetDecisionRevision(read),
      })
      const label = decisionLabelKey(proposal, decision)
      return { kind: `decided.${label}` as SuccessKind, warning: result.notice ?? null }
    })

  const distill = () =>
    void run('distill', async () => {
      const result = await distillEvolutionTarget(deviceId, targetKey, workspacePath)
      return { kind: `distill.${result.outcome}` as Notice['kind'], reason: result.reason ?? null }
    })

  const saveOverlay = () =>
    read &&
    draft &&
    void run('overlay', async () => {
      await updateEvolutionOverlay(deviceId, targetKey, draft, read.overlay.overlayRevision, workspacePath)
    })

  const toggleEvolution = () =>
    read &&
    void run('enabled', async () => {
      // Turning one object off is a revision-checked user-settings write.
      const current = await readEvolutionSettings(deviceId)
      await saveEvolutionSettings(
        deviceId,
        withItem(current.settings, read.summary.type, targetKey, !read.summary.enabled),
        current.revision
      )
    })

  const overlay = draft ?? read?.overlay.stable ?? null
  const summary = read?.summary
  const blocked = notice?.kind === 'conflict' || notice?.kind === 'unconfirmed'
  return (
    <details
      data-testid="evolution-target-section"
      className="group/details mt-2"
      onToggle={event => {
        if (event.currentTarget.open && status === 'idle') void load()
      }}
    >
      <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-md text-sm text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:min-h-8">
        {t('detail.title')}
      </summary>
      <div className="mt-2 flex flex-col gap-3 text-sm">
        {status === 'loading' && !read && (
          <p role="status" className="flex items-center gap-2 text-text-secondary">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {t('detail.loading')}
          </p>
        )}
        {status === 'missing' && <p className="text-text-muted">{t('detail.empty')}</p>}
        {status === 'failed' && (
          <p role="alert" className="text-destructive">
            {t('detail.loadFailed')}{' '}
            <Button type="button" variant="link" size="sm" onClick={() => void load()}>
              {t('actions.retry')}
            </Button>
          </p>
        )}
        {status !== 'idle' && (
        // One line stays reserved for action feedback so a result does not push the section down.
        <div data-testid="evolution-detail-notice-slot" aria-live="polite" className="min-h-[1lh]">
        {notice && (
          <div
            role={SUCCESS.has(notice.kind) ? 'status' : 'alert'}
            data-testid="evolution-detail-notice"
            data-kind={notice.kind}
            className={SUCCESS.has(notice.kind) ? 'text-text-secondary' : 'text-destructive'}
          >
            {t(`detail.notice.${notice.kind}`)}
            {notice.reason && <span className="block">{t('detail.rejectReason', { reason: notice.reason })}</span>}
            {notice.kind === 'distill.model_unavailable' && (
              <span className="block" data-testid="evolution-detail-model-hint">
                {t('detail.modelHint')}{' '}
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0"
                  data-testid="evolution-detail-open-settings"
                  onClick={() => navigateTo('/settings/personal/self-evolution')}
                >
                  {t('detail.openSettings')}
                </Button>
              </span>
            )}
            {blocked && (
              <Button type="button" variant="link" size="sm" onClick={() => void load()}>
                {t('actions.refresh')}
              </Button>
            )}
          </div>
        )}
        </div>
        )}
        {notice?.warning && (
          <p role="alert" data-testid="evolution-detail-warning" className="text-destructive">
            {t('detail.decisionWarning', { notice: notice.warning })}
          </p>
        )}
        {summary && overlay && read && (
          <>
            <div className="flex flex-wrap items-center gap-2" data-testid="evolution-detail-scores">
              <StatusChip>
                {t('detail.stableScore', {
                  score: formatScore(summary.stable, i18n.resolvedLanguage),
                  count: summary.stable.observations,
                })}
              </StatusChip>
              {summary.candidate && (
                <StatusChip>
                  {t('detail.candidateScore', {
                    score: formatScore(summary.candidate, i18n.resolvedLanguage),
                    count: summary.candidate.observations,
                    traffic: Math.round((summary.channelTraffic ?? 0) * 100),
                  })}
                </StatusChip>
              )}
              <StatusChip>{t(`targets.evolutionMode.${summary.evolutionMode}`)}</StatusChip>
              {summary.pinned && <StatusChip>{t('detail.pinned')}</StatusChip>}
              {summary.needsRevalidation && <StatusChip>{t('detail.needsRevalidation')}</StatusChip>}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-auto"
                data-testid="evolution-detail-distill"
                title={t('detail.distillHint')}
                disabled={(busy !== null && busy !== 'distill') || blocked}
                pending={busy === 'distill'}
                onClick={distill}
              >
                {t('detail.distill')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="evolution-detail-toggle"
                disabled={(busy !== null && busy !== 'enabled') || blocked}
                pending={busy === 'enabled'}
                onClick={toggleEvolution}
              >
                <StableLabel alternatives={[t('detail.disable'), t('detail.enable')]}>
                  {t(summary.enabled ? 'detail.disable' : 'detail.enable')}
                </StableLabel>
              </Button>
            </div>

            <section className="flex flex-col gap-2" aria-label={t('detail.overlay')}>
              <h4 className="text-sm font-medium text-text-primary">{t('detail.overlay')}</h4>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-text-secondary">{t('detail.lessons')}</span>
                <textarea
                  data-testid="evolution-overlay-lessons"
                  value={overlay.lessons ?? ''}
                  disabled={busy !== null || blocked}
                  onChange={event => setDraft({ ...overlay, lessons: event.target.value })}
                  className="min-h-24 w-full resize-y rounded-lg border border-border bg-background p-2 text-sm text-text-primary outline-none focus:border-focus/60"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-text-secondary">{t('detail.checklist')}</span>
                <textarea
                  data-testid="evolution-overlay-checklist"
                  value={overlay.checklist ?? ''}
                  disabled={busy !== null || blocked}
                  onChange={event => setDraft({ ...overlay, checklist: event.target.value })}
                  className="min-h-16 w-full resize-y rounded-lg border border-border bg-background p-2 text-sm text-text-primary outline-none focus:border-focus/60"
                />
              </label>
              {(overlay.examples ?? []).length > 0 && (
                <p className="text-xs text-text-muted">
                  {t('detail.examples', { count: (overlay.examples ?? []).length })}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  data-testid="evolution-overlay-save"
                  disabled={!draft || (busy !== null && busy !== 'overlay') || blocked}
                  pending={busy === 'overlay'}
                  onClick={saveOverlay}
                >
                  {t('actions.save')}
                </Button>
                {draft && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
                    {t('actions.cancel')}
                  </Button>
                )}
              </div>
            </section>

            <section className="flex flex-col gap-2" aria-label={t('detail.patterns')}>
              <h4 className="text-sm font-medium text-text-primary">{t('detail.patterns')}</h4>
              {read.patterns.length === 0 && <p className="text-text-muted">{t('detail.noPatterns')}</p>}
              <ul className="flex flex-col gap-2">
                {read.patterns.map(pattern => (
                  <li key={pattern.id} data-testid="evolution-pattern" className="flex flex-col gap-1">
                    <span className="text-text-primary">{pattern.statement}</span>
                    <span className="flex flex-wrap items-center gap-1">
                      <StatusChip>{t(`detail.patternScope.${pattern.scope}`)}</StatusChip>
                      {pattern.categories.map(category => (
                        <StatusChip key={category}>{category}</StatusChip>
                      ))}
                    </span>
                    <span className="text-xs text-text-secondary">
                      {t('detail.evidence', {
                        usages: pattern.support.usages,
                        sessions: pattern.support.sessions,
                        users: pattern.support.users,
                        counter: pattern.counterEvidence,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="flex flex-col gap-2" aria-label={t('detail.proposals')}>
              <h4 className="text-sm font-medium text-text-primary">{t('detail.proposals')}</h4>
              {read.proposals.length === 0 && <p className="text-text-muted">{t('detail.noProposals')}</p>}
              <ul className="flex flex-col gap-3">
                {read.proposals.map(proposal => (
                  <li
                    key={proposal.id}
                    data-testid="evolution-proposal"
                    data-state={proposal.state}
                    className="flex flex-col gap-1 rounded-lg border border-border/60 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip>{t(`detail.state.${proposal.state}`)}</StatusChip>
                      <span className="text-xs text-text-secondary">
                        {t(`detail.actor.${proposal.actor}`)} ·{' '}
                        {new Date(proposal.createdAt).toLocaleString(i18n.resolvedLanguage)}
                      </span>
                    </div>
                    {proposal.evaluation && (
                      <p className="text-xs text-text-secondary" data-testid="evolution-proposal-evaluation">
                        {t(proposal.evaluation.completed ? 'detail.evaluation' : 'detail.evaluationRunning', {
                          winRate:
                            proposal.evaluation.winRate == null
                              ? t('detail.unknownValue')
                              : `${Math.round(proposal.evaluation.winRate * 100)}%`,
                          ties: proposal.evaluation.ties,
                          regressions: proposal.evaluation.hardCheckRegressions,
                        })}
                        {proposal.evaluation.diversityDelta != null &&
                          ` · ${t('detail.diversityDelta', {
                            delta: `${proposal.evaluation.diversityDelta > 0 ? '+' : ''}${Math.round(proposal.evaluation.diversityDelta * 100)}%`,
                          })}`}
                      </p>
                    )}
                    {proposal.rejectReason && (
                      <p className="text-xs text-text-secondary">
                        {t('detail.rejectReason', { reason: proposal.rejectReason })}
                      </p>
                    )}
                    <details>
                      <summary className="cursor-pointer text-xs text-text-secondary">{t('detail.diff')}</summary>
                      <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-code">
                        {proposal.diff}
                      </pre>
                    </details>
                    <div className="flex flex-wrap gap-2">
                      {proposalDecisions(proposal).map(decision => (
                        <Button
                          key={decision}
                          type="button"
                          size="sm"
                          variant={decision === 'accept' ? 'default' : decision === 'reject' ? 'destructive' : 'outline'}
                          data-testid={`evolution-proposal-${decision}`}
                          title={t(`detail.decisionHint.${decisionLabelKey(proposal, decision)}`)}
                          disabled={(busy !== null && busy !== `${proposal.id}:${decision}`) || blocked}
                          pending={busy === `${proposal.id}:${decision}`}
                          onClick={() => decide(proposal, decision)}
                        >
                          {t(`detail.decision.${decisionLabelKey(proposal, decision)}`)}
                        </Button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </details>
  )
}
