import { runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import { type PendingRuntimeGoalState, type RuntimeTaskLoadTarget } from './sessionTypes'

export const noopSetInput = () => undefined

export function isInterruptedGuidance(message: RuntimePaneQueuedMessage): boolean {
  return message.status === 'sending' && message.notice === '正在引导当前对话'
}

export function runtimeTaskLoadTargetFromAddress(
  address: RuntimeTaskAddress
): RuntimeTaskLoadTarget {
  return {
    key: runtimeTranscriptPaneKey(address),
    identityKey: runtimeTranscriptPaneIdentityKey(address),
    address,
  }
}

export const runtimeTranscriptPaneKey = runtimeConversationKey

export function runtimeTranscriptPaneIdentityKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}:${address.taskId}`
}

export function requestUserInputAnswerScopeKey(
  target: RuntimeTaskLoadTarget | null
): string | null {
  // After initial load, workspacePath and route deviceId may both be canonicalized; taskId is the stable identity.
  return target?.address.taskId ?? null
}

export function isPendingGoalVisibleForRuntimeTarget(
  pendingGoalState: PendingRuntimeGoalState,
  address: RuntimeTaskAddress
): boolean {
  if (!pendingGoalState.targetKey && !pendingGoalState.targetIdentityKey) return true
  return (
    pendingGoalState.targetKey === runtimeTranscriptPaneKey(address) ||
    pendingGoalState.targetIdentityKey === runtimeTranscriptPaneIdentityKey(address)
  )
}

export function isUnboundPendingGoalState(pendingGoalState: PendingRuntimeGoalState): boolean {
  return !pendingGoalState.targetKey && !pendingGoalState.targetIdentityKey
}
