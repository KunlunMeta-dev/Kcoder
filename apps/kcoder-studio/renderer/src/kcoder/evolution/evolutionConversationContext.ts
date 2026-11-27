import { createContext, useContext } from 'react'

export type EvolutionTurnRatingValue = 'up' | 'down'

export interface EvolutionConversationValue {
  deviceId: string
  taskId: string
  /** Set when the conversation shows a subagent of `taskId`; turn ids are then child turns. */
  subagentId?: string
  /** Capability present, evolution enabled and `signals.rating_ui` on for this target. */
  ratingEnabled: boolean
  /** Local projection of ratings this client recorded, by recorded turn id; the server stays authoritative. */
  ratings: ReadonlyMap<string, EvolutionTurnRatingValue>
  rememberRating(turnId: string, rating: EvolutionTurnRatingValue): void
  /**
   * Server projection of the turns `evolution/rate` accepts
   * (`evolution/ratings/list`); `null` until loaded or when unavailable.
   */
  ratableTurns?: ReadonlyArray<EvolutionRatableTurnView> | null
  /**
   * A completed message with skill calls has no ratable turn yet: reload the
   * projection once for `key` (coalesced; the same key never reloads twice).
   */
  requestRatableTurns?(key: string): void
}

export interface EvolutionRatableTurnView {
  /** Recorded turn id; the one `evolution/rate` is sent with. */
  turnId: string
  toolCallIds: readonly string[]
  /** The rating that stands on the server. */
  rating: EvolutionTurnRatingValue | null
}

export const EvolutionConversationContext = createContext<EvolutionConversationValue | null>(null)

export function useEvolutionConversation(): EvolutionConversationValue | null {
  return useContext(EvolutionConversationContext)
}

type SkillBlock = { type?: string; toolName?: string; id?: string; status?: string }

/** A turn qualifies for rating only when it activated a skill. */
export function turnUsedSkill(blocks: ReadonlyArray<SkillBlock> | undefined) {
  return skillToolCallIds(blocks).length > 0
}

/**
 * Ids of the `skill` calls in `blocks` that completed. A failed, running or
 * unknown call never recorded a usage, so it does not make a turn ratable.
 */
export function skillToolCallIds(blocks: ReadonlyArray<SkillBlock> | undefined): string[] {
  return (blocks ?? []).flatMap(block =>
    block.type === 'tool' &&
    block.toolName === 'skill' &&
    typeof block.id === 'string' &&
    block.id &&
    (block.status === undefined || block.status === 'done')
      ? [block.id]
      : []
  )
}

/**
 * The server's ratable turn a message shows: the one that recorded one of the
 * message's skill calls, or, for usages recorded before tool calls were kept,
 * the one with the message's own turn id.
 */
export function ratableTurnFor(
  message: { turnId?: string; toolCallIds: readonly string[] },
  turns: ReadonlyArray<EvolutionRatableTurnView> | null | undefined
): EvolutionRatableTurnView | null {
  if (!turns || message.toolCallIds.length === 0) return null
  return (
    turns.find(turn => turn.toolCallIds.some(id => message.toolCallIds.includes(id))) ??
    turns.find(turn => turn.toolCallIds.length === 0 && turn.turnId === message.turnId) ??
    null
  )
}
