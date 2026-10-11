import type { RuntimeSubagentActivityPayload } from '@/types/api'
import type { RuntimeSubagentStatus } from '@/types/workbench'

export function markRuntimeSubagentsSettled(current: RuntimeSubagentStatus[]): RuntimeSubagentStatus[] {
  let changed = false
  const settled = current.map(status => {
    // Background agents outlive the parent turn; only their own terminal events settle them.
    if (status.status !== 'running' || status.kind === 'background') return status
    changed = true
    return { ...status, status: 'done' as const, updatedAtMs: Date.now() }
  })
  return changed ? settled : current
}

type SteeringState = Pick<RuntimeSubagentStatus,
  'steerStatus' | 'steerMessageId' | 'clientMessageId' | 'appliedSteerMessageIds' | 'observedSteerMessageIds'>

export function mergeSubagentSteeringState(
  previous: RuntimeSubagentStatus | undefined,
  activity: RuntimeSubagentActivityPayload
): SteeringState {
  const state: SteeringState = {
    steerStatus: previous?.steerStatus,
    steerMessageId: previous?.steerMessageId,
    clientMessageId: previous?.clientMessageId,
    appliedSteerMessageIds: previous?.appliedSteerMessageIds,
    observedSteerMessageIds: previous?.observedSteerMessageIds,
  }
  const incoming = activity.steerStatus
  if (!incoming) return state
  const id = activity.steerMessageId
  const applied = state.appliedSteerMessageIds ?? []
  const observed = state.observedSteerMessageIds ??
    (previous?.steerMessageId ? [previous.steerMessageId] : [])
  // Server message identity, not arrival order or cross-host clocks, determines completion.
  if (id && applied.includes(id)) return state
  if (previous?.steerStatus === 'applied' && incoming !== 'applied' &&
      (!id || id === previous.steerMessageId)) return state
  if (id && !observed.includes(id)) {
    state.observedSteerMessageIds = [...observed, id].slice(-32)
  }
  if (incoming === 'applied' && id) {
    state.appliedSteerMessageIds = [...applied.filter(value => value !== id), id].slice(-32)
  }
  // Only suppress an older identity when its order was actually observed.
  // An unseen completion may arrive before its own queued acknowledgement.
  if (id && previous?.steerMessageId && observed.includes(id) &&
      observed.indexOf(id) < observed.indexOf(previous.steerMessageId)) return state
  return {
    ...state,
    steerStatus: incoming,
    steerMessageId: id ?? previous?.steerMessageId,
    clientMessageId: activity.clientMessageId ??
      (id && id !== previous?.steerMessageId ? undefined : previous?.clientMessageId),
  }
}
