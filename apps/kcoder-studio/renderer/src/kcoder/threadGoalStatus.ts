import type { RuntimeGoalStatus, RuntimeGoalStatusObservation } from '@/types/api'

const statuses = new Set<RuntimeGoalStatus>([
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
  'cancelled',
])

/** Malformed or future observations remain unknown rather than implying completion. */
export function parseThreadGoalStatusObservation(value: unknown, expectedThreadId?: string): RuntimeGoalStatusObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { availability: 'unavailable' }
  const observation = value as Record<string, unknown>
  if (Object.keys(observation).some(key => key !== 'availability' && key !== 'status' &&
      !(key === 'threadId' && expectedThreadId !== undefined && observation.threadId === expectedThreadId)))
    return { availability: 'unavailable' }
  if (observation.availability !== 'available') return { availability: 'unavailable' }
  if (observation.status === null) return { availability: 'available', status: null }
  if (typeof observation.status === 'string' && statuses.has(observation.status as RuntimeGoalStatus))
    return { availability: 'available', status: observation.status as RuntimeGoalStatus }
  return { availability: 'unavailable' }
}

/** Preserve absence for old clients while treating malformed new observations as unknown. */
export function readThreadGoalStatusObservation(record: Record<string, unknown>): RuntimeGoalStatusObservation | undefined {
  const key = Object.hasOwn(record, 'goalStatusObservation') ? 'goalStatusObservation'
    : Object.hasOwn(record, 'goal_status_observation') ? 'goal_status_observation' : null
  return key ? parseThreadGoalStatusObservation(record[key]) : undefined
}
