import type { RuntimeGoal, RuntimeGoalCreateInput, RuntimeTaskAddress } from '@/types/api'
import { getLruMapValue, setLruMapValue } from './paneMessageReducer'
import { runtimeTranscriptPaneIdentityKey, runtimeTranscriptPaneKey } from './sessionIdentity'
import { type PendingRuntimeGoalState } from './sessionTypes'

export const runtimePaneGoalSeeds = new Map<string, PendingRuntimeGoalState>()

export const MAX_CACHED_RUNTIME_PANE_GOALS = 3

export function pendingRuntimeGoalState(
  goal: RuntimeGoal,
  address: RuntimeTaskAddress
): PendingRuntimeGoalState {
  return {
    goal,
    targetKey: runtimeTranscriptPaneKey(address),
    targetIdentityKey: runtimeTranscriptPaneIdentityKey(address),
  }
}

export function seedRuntimePaneGoal(address: RuntimeTaskAddress, goal: RuntimeGoal) {
  setLruMapValue(
    runtimePaneGoalSeeds,
    runtimeTranscriptPaneIdentityKey(address),
    { ...pendingRuntimeGoalState(goal, address), creationPending: true },
    MAX_CACHED_RUNTIME_PANE_GOALS
  )
}

export function getRuntimePaneGoalSeed(
  address: RuntimeTaskAddress
): PendingRuntimeGoalState | null {
  return getLruMapValue(runtimePaneGoalSeeds, runtimeTranscriptPaneIdentityKey(address)) ?? null
}

export function confirmRuntimePaneGoalSeed(address: RuntimeTaskAddress) {
  const key = runtimeTranscriptPaneIdentityKey(address)
  const seed = runtimePaneGoalSeeds.get(key)
  if (seed) runtimePaneGoalSeeds.set(key, { ...seed, creationPending: false })
}

export function clearRuntimePaneGoalSeed(address: RuntimeTaskAddress) {
  runtimePaneGoalSeeds.delete(runtimeTranscriptPaneIdentityKey(address))
}

export function createPendingRuntimeGoal(
  objective: string,
  mode: RuntimeGoal['mode'] = 'standard'
): RuntimeGoal {
  const now = Date.now()
  return {
    threadId: 'pending',
    objective,
    mode,
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  }
}

export function runtimeGoalCreateInput(goal: RuntimeGoal): RuntimeGoalCreateInput {
  return {
    objective: goal.objective,
    mode: goal.mode,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
  }
}
