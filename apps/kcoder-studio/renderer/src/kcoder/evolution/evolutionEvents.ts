import type { EvolutionChangedNotification, EvolutionChangedReason } from './evolutionContract'

export interface EvolutionChangedEvent extends EvolutionChangedNotification {
  /** Target that emitted the notification; listeners ignore other targets. */
  deviceId: string
}

const REASONS = new Set<EvolutionChangedReason>([
  'proposal',
  'promoted',
  'rolled_back',
  'settings',
  'cleared',
])
const listeners = new Set<(event: EvolutionChangedEvent) => void>()

/** Validate an `evolution/changed` frame; malformed frames are dropped, never guessed. */
export function parseEvolutionChanged(
  deviceId: string | undefined,
  params: Record<string, unknown>
): EvolutionChangedEvent | null {
  if (!deviceId || !REASONS.has(params.reason as EvolutionChangedReason)) return null
  if (params.targetKey !== undefined && typeof params.targetKey !== 'string') return null
  return {
    deviceId,
    reason: params.reason as EvolutionChangedReason,
    ...(typeof params.targetKey === 'string' ? { targetKey: params.targetKey } : {}),
  }
}

export function publishEvolutionChanged(event: EvolutionChangedEvent): void {
  for (const listener of [...listeners]) listener(event)
}

export function subscribeEvolutionChanged(
  listener: (event: EvolutionChangedEvent) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A rating this client recorded outside the inline control, such as `/rate`. */
export interface EvolutionTurnRatedEvent {
  deviceId: string
  taskId: string
  subagentId?: string
  turnId: string
  rating: 'up' | 'down'
}

const turnRatedListeners = new Set<(event: EvolutionTurnRatedEvent) => void>()

/** Publish only after the runtime confirmed `recorded`; listeners update local projections. */
export function publishEvolutionTurnRated(event: EvolutionTurnRatedEvent): void {
  for (const listener of [...turnRatedListeners]) listener(event)
}

export function subscribeEvolutionTurnRated(
  listener: (event: EvolutionTurnRatedEvent) => void
): () => void {
  turnRatedListeners.add(listener)
  return () => {
    turnRatedListeners.delete(listener)
  }
}
