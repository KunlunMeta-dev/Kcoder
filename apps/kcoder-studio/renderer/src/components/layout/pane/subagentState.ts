import type { RuntimeSubagentActivityPayload, RuntimeTaskAddress } from '@/types/api'
import type { RuntimeSubagentStatus, WorkbenchMessage } from '@/types/workbench'
import { mergeSubagentSteeringState } from '../subagentSteerState'

export function updateRuntimeSubagentStatuses(
  current: RuntimeSubagentStatus[],
  activity: RuntimeSubagentActivityPayload
): RuntimeSubagentStatus[] {
  const agentPath = activity.agentPath.trim()
  if (!agentPath) return current

  const agentId = runtimeSubagentId(activity)
  const status = normalizeRuntimeSubagentStatus(activity.status ?? activity.kind)
  const previousStatus = current.find(item => item.id === agentId)
  const nextStatus: RuntimeSubagentStatus = {
    id: agentId,
    agentId,
    agentPath,
    agentName:
      activity.agentName?.trim() || previousStatus?.agentName || runtimeSubagentName(agentId),
    status,
    kind: activity.kind,
    ...mergeSubagentSteeringState(previousStatus, activity),
    retainedRuns: activity.retainedRuns ?? previousStatus?.retainedRuns,
    retainedRunLimit: activity.retainedRunLimit ?? previousStatus?.retainedRunLimit,
    capacityWarning: activity.capacityWarning ?? previousStatus?.capacityWarning,
    updatedAtMs: activity.occurredAtMs ?? Date.now(),
  }

  const withoutCurrent = current.filter(item => item.id !== agentId)
  return [...withoutCurrent, nextStatus].sort((left, right) => {
    const leftTime = left.updatedAtMs ?? 0
    const rightTime = right.updatedAtMs ?? 0
    return rightTime - leftTime
  })
}

export function hasUnsettledRuntimePaneState(messages: WorkbenchMessage[]): boolean {
  return messages.some(
    message =>
      message.status === 'streaming' ||
      message.status === 'pending' ||
      message.blocks?.some(block =>
        ['generating_arguments', 'pending', 'streaming'].includes(block.status)
      )
  )
}

export function normalizeRuntimeSubagentStatus(
  value: string | undefined
): RuntimeSubagentStatus['status'] {
  const normalized = value?.replace(/_/g, '').toLowerCase()
  if (normalized === 'paused') return 'paused'
  if (normalized === 'done' || normalized === 'completed' || normalized === 'taskcomplete') {
    return 'done'
  }
  if (
    normalized === 'interrupted' ||
    normalized === 'cancelled' ||
    normalized === 'canceled' ||
    normalized === 'halted' ||
    normalized === 'failed'
  ) {
    return 'interrupted'
  }
  return 'running'
}

export function runtimeSubagentId(activity: RuntimeSubagentActivityPayload): string {
  const agentId = activity.agentId?.trim()
  if (agentId) return agentId

  const threadId = activity.agentThreadId?.trim()
  if (threadId) return threadId

  const agentPath = activity.agentPath.trim()
  if (agentPath.startsWith('thread:')) {
    return agentPath.slice('thread:'.length).trim() || agentPath
  }
  return agentPath
}

export function runtimeSubagentName(agentId: string): string {
  const parts = agentId.split('/').filter(Boolean)
  const lastPart = parts[parts.length - 1] ?? agentId
  if (!lastPart || lastPart.startsWith('019') || lastPart.length > 16) {
    return `Agent ${shortRuntimeAgentId(agentId)}`
  }
  return lastPart
}

export function shortRuntimeAgentId(agentId: string): string {
  const normalized = agentId.replace(/^thread:/, '').trim()
  return normalized.length > 8 ? normalized.slice(-8) : normalized || 'subagent'
}

export function isRuntimeTaskAddress(value: unknown): value is RuntimeTaskAddress {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RuntimeTaskAddress>
  return typeof candidate.deviceId === 'string' && typeof candidate.taskId === 'number'
}
