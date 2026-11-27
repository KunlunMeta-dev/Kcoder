import { useEffect, useState } from 'react'
import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { evolutionFailureKind, rateEvolutionTurn } from '@/kcoder/evolution/evolutionApi'
import { EVOLUTION_RATE_REASON_MAX_CHARS } from '@/kcoder/evolution/evolutionContract'
import {
  ratableTurnFor,
  skillToolCallIds,
  useEvolutionConversation,
  type EvolutionTurnRatingValue,
} from '@/kcoder/evolution/evolutionConversationContext'
import type { WorkbenchMessage } from '@/types/workbench'

type RatingFailure = 'failed' | 'failedNoUsage' | 'failedDisabled' | 'failedNotFound' | 'failedUnconfirmed'

function failureOf(error: unknown): RatingFailure {
  switch (evolutionFailureKind(error, true)) {
    case 'disabled':
    case 'unsupported':
      return 'failedDisabled'
    case 'not_found':
      return 'failedNotFound'
    case 'unconfirmed':
      return 'failedUnconfirmed'
    default:
      return 'failed'
  }
}

/**
 * Lightweight thumbs rating for a completed assistant turn that used a skill.
 * Renders nothing unless the conversation provider confirmed the capability,
 * evolution is enabled, the rating control signal is on and the server lists
 * the turn as ratable (one of its completed `skill` calls recorded a usage).
 */
export function EvolutionTurnRating({ message }: { message: WorkbenchMessage }) {
  const { t } = useTranslation('evolution')
  const conversation = useEvolutionConversation()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<RatingFailure | null>(null)
  const [reasonOpen, setReasonOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonSaved, setReasonSaved] = useState(false)
  const toolCallIds = skillToolCallIds(message.blocks)
  const settled = message.status !== 'streaming' && message.status !== 'unknown'
  const candidate = Boolean(conversation?.ratingEnabled && settled && toolCallIds.length > 0)
  const ratable = candidate
    ? ratableTurnFor({ turnId: message.turnId, toolCallIds }, conversation?.ratableTurns)
    : null
  const loaded = conversation?.ratableTurns != null
  const requestKey = `${message.id}:${toolCallIds.join(',')}`
  const request = conversation?.requestRatableTurns
  useEffect(() => {
    // A newly completed skill message the last projection does not cover yet.
    if (candidate && loaded && !ratable) request?.(requestKey)
  }, [candidate, loaded, ratable, request, requestKey])
  if (!conversation || !ratable) return null
  const turnId = ratable.turnId
  const current = conversation.ratings.get(turnId) ?? ratable.rating

  const submit = async (rating: EvolutionTurnRatingValue, withReason?: string) => {
    if (pending) return
    // Repeating the standing rating changes nothing on the server.
    if (rating === current && !withReason) return
    setPending(true)
    setFailure(null)
    try {
      // The latest rating stands; a later reason is recorded with it.
      const result = await rateEvolutionTurn({
        deviceId: conversation.deviceId,
        taskId: conversation.taskId,
        ...(conversation.subagentId ? { subagentId: conversation.subagentId } : {}),
        turnId,
        toolCallIds,
        rating,
        ...(withReason ? { reason: withReason } : {}),
      })
      if (!result.recorded) {
        // The usage is gone (cleared data, rating signal off): say so exactly.
        setFailure('failedNoUsage')
        return
      }
      conversation.rememberRating(turnId, rating)
      setReasonSaved(false)
      if (withReason) {
        setReasonOpen(false)
        setReasonSaved(true)
      }
    } catch (error) {
      setFailure(failureOf(error))
    } finally {
      setPending(false)
    }
  }

  const thumb = (rating: EvolutionTurnRatingValue) => {
    const Icon = rating === 'up' ? ThumbsUp : ThumbsDown
    const selected = current === rating
    return (
      <button
        type="button"
        data-testid={`evolution-rate-${rating}`}
        aria-pressed={selected}
        aria-label={t(rating === 'up' ? 'rating.up' : 'rating.down')}
        title={t(rating === 'up' ? 'rating.up' : 'rating.down')}
        disabled={pending}
        onClick={() => void submit(rating)}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-md transition-colors disabled:opacity-50 max-md:h-11 max-md:w-11',
          selected
            ? 'bg-text-primary/10 text-text-primary'
            : 'text-text-muted hover:bg-muted hover:text-text-secondary'
        )}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    )
  }

  return (
    <div data-testid="evolution-turn-rating" className="mt-1 flex flex-col gap-1 text-xs text-text-muted">
      <div className="flex items-center gap-1">
        <span className="pr-1">{t('rating.prompt')}</span>
        {thumb('up')}
        {thumb('down')}
        {current && !reasonOpen && !reasonSaved && (
          <button
            type="button"
            data-testid="evolution-rate-reason-open"
            onClick={() => setReasonOpen(true)}
            className="rounded-md px-1 text-text-secondary hover:text-text-primary"
          >
            {t('rating.addReason')}
          </button>
        )}
        {reasonSaved && <span role="status">{t('rating.reasonSaved')}</span>}
        {failure && (
          <span role="alert" className="text-destructive">
            {t(`rating.${failure}`)}
          </span>
        )}
      </div>
      {reasonOpen && current && (
        <form
          className="flex max-w-md items-center gap-2"
          onSubmit={event => {
            event.preventDefault()
            if (reason.trim()) void submit(current, reason.trim())
          }}
        >
          <input
            data-testid="evolution-rate-reason"
            aria-label={t('rating.reasonLabel')}
            placeholder={t('rating.reasonPlaceholder')}
            maxLength={EVOLUTION_RATE_REASON_MAX_CHARS}
            value={reason}
            onChange={event => setReason(event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-sm text-text-primary outline-none focus:border-focus/60"
          />
          <button
            type="submit"
            disabled={pending || !reason.trim()}
            className="rounded-md px-2 py-1 text-text-primary hover:bg-muted disabled:opacity-50"
          >
            {t('rating.sendReason')}
          </button>
        </form>
      )}
    </div>
  )
}
