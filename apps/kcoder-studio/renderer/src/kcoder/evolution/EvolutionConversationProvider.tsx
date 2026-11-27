import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import {
  decideEvolutionProposal,
  listEvolutionRatings,
  readEvolutionSettings,
  readEvolutionStatus,
  readEvolutionTarget,
  supportsSelfEvolution,
} from './evolutionApi'
import {
  EvolutionConversationContext,
  type EvolutionConversationValue,
  type EvolutionRatableTurnView,
  type EvolutionTurnRatingValue,
} from './evolutionConversationContext'
import { subscribeEvolutionChanged, subscribeEvolutionTurnRated } from './evolutionEvents'
import { latestPromotedProposal, targetDecisionRevision } from './evolutionTargetModel'

interface Address {
  deviceId: string
  taskId: string
  workspacePath?: string | null
}

interface PromotionNotice {
  targetKey: string
  name: string
  proposalId: string | null
  revision: string
  state: 'idle' | 'undoing' | 'undone' | 'failed'
}

/**
 * Conversation-scoped evolution projection: rating gate and the one-line
 * promotion notice. Without the target capability nothing is requested or shown.
 */
export function EvolutionConversationProvider({
  address,
  subagentId,
  promotionNotice = true,
  children,
}: {
  address: Address | null | undefined
  /** Rates child-agent turns of the parent task's thread (`evolution/rate.subagentId`). */
  subagentId?: string
  /** The overlay notice needs a positioned conversation container; secondary panes omit it. */
  promotionNotice?: boolean
  children: ReactNode
}) {
  const deviceId = address?.deviceId ?? ''
  const taskId = address?.taskId ?? ''
  const workspace = address?.workspacePath ?? undefined
  const [gate, setGate] = useState<{ key: string; enabled: boolean; supported: boolean } | null>(null)
  const [ratings, setRatings] = useState<Map<string, EvolutionTurnRatingValue>>(new Map())
  const [notice, setNotice] = useState<PromotionNotice | null>(null)
  const generation = useRef(0)
  const key = JSON.stringify([deviceId, taskId])
  const ratableKey = JSON.stringify([deviceId, taskId, subagentId ?? ''])
  const [ratable, setRatable] = useState<{ key: string; turns: EvolutionRatableTurnView[] } | null>(null)
  // Message keys that already caused a reload; each completed skill message
  // reloads at most once, so an unmatched one never polls.
  const requestedKeys = useRef(new Set<string>())
  const ratableLoad = useRef<{ key: string; running: boolean; again: boolean; ticket: number }>({
    key: '',
    running: false,
    again: false,
    ticket: 0,
  })

  const loadGate = useCallback(async () => {
    if (!deviceId || !taskId) return
    const ticket = ++generation.current
    try {
      const supported = await supportsSelfEvolution(deviceId)
      if (!supported) {
        if (ticket === generation.current) setGate({ key, enabled: false, supported: false })
        return
      }
      const [status, settings] = await Promise.all([
        readEvolutionStatus(deviceId),
        readEvolutionSettings(deviceId),
      ])
      if (ticket !== generation.current) return
      setGate({
        key,
        supported: true,
        enabled: status.enabled && !status.disabledReason && settings.settings.signals.rating_ui,
      })
    } catch {
      // Unknown state hides the control rather than guessing that ratings are accepted.
      if (ticket === generation.current) setGate({ key, enabled: false, supported: false })
    }
  }, [deviceId, key, taskId])

  useEffect(() => {
    queueMicrotask(() => void loadGate())
    return () => {
      generation.current += 1
    }
  }, [loadGate])

  const supported = gate?.key === key && gate.supported
  useEffect(() => {
    if (!supported) return
    return subscribeEvolutionChanged(event => {
      if (event.deviceId !== deviceId) return
      if (event.reason === 'settings' || event.reason === 'cleared') void loadGate()
      if (!promotionNotice || event.reason !== 'promoted' || !event.targetKey) return
      const targetKey = event.targetKey
      void readEvolutionTarget(deviceId, targetKey, workspace).then(
        read =>
          setNotice({
            targetKey,
            name: read.summary.name,
            proposalId: latestPromotedProposal(read.proposals)?.id ?? null,
            revision: targetDecisionRevision(read),
            state: 'idle',
          }),
        () => undefined
      )
    })
  }, [deviceId, loadGate, promotionNotice, supported, workspace])

  const rememberRating = useCallback((turnId: string, rating: EvolutionTurnRatingValue) => {
    setRatings(current => new Map(current).set(turnId, rating))
  }, [])

  const enabled = gate?.key === key && gate.enabled
  // The server says which turns `evolution/rate` accepts; the client never
  // guesses from its own turn ids. One request in flight, coalesced.
  // The coalesced re-run calls the latest loader through a ref so the
  // callback never references itself before its declaration completes.
  const loadRatableLatest = useRef<() => void>(() => {})
  const loadRatable = useCallback(() => {
    const load = ratableLoad.current
    if (load.key !== ratableKey) {
      load.key = ratableKey
      load.running = false
      load.again = false
      load.ticket += 1
    }
    if (load.running) {
      load.again = true
      return
    }
    load.running = true
    const ticket = load.ticket
    const owner = ratableKey
    void listEvolutionRatings({ deviceId, taskId, ...(subagentId ? { subagentId } : {}) })
      .then(
        result =>
          result.items.map(item => ({
            turnId: item.turnId,
            toolCallIds: item.toolCallIds ?? [],
            rating: item.rating ?? null,
          })),
        // Unknown eligibility hides the control rather than guessing.
        () => [] as EvolutionRatableTurnView[]
      )
      .then(turns => {
        if (ratableLoad.current.ticket !== ticket) return
        setRatable({ key: owner, turns })
        const current = ratableLoad.current
        current.running = false
        if (current.again) {
          current.again = false
          loadRatableLatest.current()
        }
      })
  }, [deviceId, ratableKey, subagentId, taskId])
  useEffect(() => {
    loadRatableLatest.current = loadRatable
  }, [loadRatable])

  useEffect(() => {
    requestedKeys.current = new Set()
    if (enabled) loadRatable()
  }, [enabled, loadRatable])

  useEffect(() => {
    if (!enabled) return
    return subscribeEvolutionChanged(event => {
      if (event.deviceId !== deviceId || event.reason !== 'cleared') return
      requestedKeys.current = new Set()
      setRatings(new Map())
      loadRatable()
    })
  }, [deviceId, enabled, loadRatable])

  const requestRatableTurns = useCallback(
    (messageKey: string) => {
      if (!enabled || requestedKeys.current.has(messageKey)) return
      requestedKeys.current.add(messageKey)
      loadRatable()
    },
    [enabled, loadRatable]
  )

  useEffect(
    () =>
      subscribeEvolutionTurnRated(event => {
        if (
          event.deviceId === deviceId &&
          event.taskId === taskId &&
          (event.subagentId ?? '') === (subagentId ?? '')
        )
          rememberRating(event.turnId, event.rating)
      }),
    [deviceId, rememberRating, subagentId, taskId]
  )

  const value = useMemo<EvolutionConversationValue | null>(
    () =>
      deviceId && taskId
        ? {
            deviceId,
            taskId,
            ...(subagentId ? { subagentId } : {}),
            ratingEnabled: enabled,
            ratings,
            rememberRating,
            ratableTurns: ratable?.key === ratableKey ? ratable.turns : null,
            requestRatableTurns,
          }
        : null,
    [
      deviceId,
      enabled,
      ratable,
      ratableKey,
      ratings,
      rememberRating,
      requestRatableTurns,
      subagentId,
      taskId,
    ]
  )

  const undo = async () => {
    if (!notice?.proposalId || notice.state === 'undoing') return
    const current = notice
    setNotice({ ...current, state: 'undoing' })
    try {
      await decideEvolutionProposal(deviceId, {
        ...(workspace ? { workspace } : {}),
        targetKey: current.targetKey,
        proposalId: current.proposalId!,
        decision: 'rollback',
        expectedRevision: current.revision,
      })
      setNotice(latest => (latest?.targetKey === current.targetKey ? { ...current, state: 'undone' } : latest))
    } catch {
      setNotice(latest => (latest?.targetKey === current.targetKey ? { ...current, state: 'failed' } : latest))
    }
  }

  return (
    <EvolutionConversationContext.Provider value={value}>
      {children}
      {notice && <PromotionNoticeLine notice={notice} onUndo={() => void undo()} onClose={() => setNotice(null)} />}
    </EvolutionConversationContext.Provider>
  )
}

function PromotionNoticeLine({
  notice,
  onUndo,
  onClose,
}: {
  notice: PromotionNotice
  onUndo: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('evolution')
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-4">
      <div
        role="status"
        data-testid="evolution-promotion-notice"
        className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-border bg-popover px-3 py-1 text-sm text-text-secondary shadow-sm"
      >
        <Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">
          {t(
            notice.state === 'undone'
              ? 'notice.promotionUndone'
              : notice.state === 'failed'
                ? 'notice.promotionUndoFailed'
                : 'notice.promoted',
            { name: notice.name }
          )}
        </span>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-1"
          data-testid="evolution-promotion-view"
          onClick={() => navigateTo('/settings/personal/self-evolution')}
        >
          {t('notice.view')}
        </Button>
        {notice.proposalId && notice.state !== 'undone' && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-1"
            data-testid="evolution-promotion-undo"
            disabled={notice.state === 'undoing'}
            onClick={onUndo}
          >
            {t('notice.undo')}
          </Button>
        )}
        <button
          type="button"
          aria-label={t('actions.dismiss')}
          onClick={onClose}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-muted"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
