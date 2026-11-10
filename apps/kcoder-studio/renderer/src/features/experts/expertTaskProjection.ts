import { isContract } from '../../../../shared/generated/validator.mjs'
import type { AgentTaskBinding, ChannelTaskSource } from '../../../../shared/generated/contracts'
import type { RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import type { ExpertConversationScope } from './conversationRoutes'

export function expertTaskBinding(task: RuntimeTaskSummary): AgentTaskBinding | null {
  const value = task.runtimeHandle?.agentDefinition
  return isContract('AgentTaskBinding', value) ? (value as AgentTaskBinding) : null
}

export function expertTaskChannelId(task: RuntimeTaskSummary): string | undefined {
  const binding = expertTaskBinding(task)
  if (binding?.source === 'channel' && binding.sourceId) return binding.sourceId
  const source = task.runtimeHandle?.channelTaskSource
  return isContract('ChannelTaskSource', source)
    ? (source as ChannelTaskSource).channelId
    : undefined
}

/** Links retain the task's original source, never the previously selected channel. */
export function expertTaskConversationScope(
  scope: ExpertConversationScope,
  task: RuntimeTaskSummary
): ExpertConversationScope {
  return {
    deviceId: scope.deviceId,
    workspacePath: scope.workspacePath,
    expertId: expertTaskBinding(task)?.definition.id,
    channelId: expertTaskChannelId(task),
  }
}

/** Presentation filters never delete or fork the authoritative Native task. */
export function isExpertConversation(task: RuntimeTaskSummary): boolean {
  return (
    !!expertTaskBinding(task) ||
    isContract('ChannelTaskSource', task.runtimeHandle?.channelTaskSource) ||
    (task.optimistic === true &&
      isContract('AgentDefinitionRef', task.runtimeHandle?.pendingAgentDefinition))
  )
}

export function expertConversationTasks(
  work: RuntimeWorkListResponse | null | undefined,
  scope: ExpertConversationScope
) {
  const spaces = [
    ...(work?.chats ?? []),
    ...(work?.projects.flatMap(item => item.deviceWorkspaces) ?? []),
  ].filter(
    space =>
      space.deviceId === scope.deviceId &&
      sameWorkspacePath(space.workspacePath, scope.workspacePath)
  )
  const seen = new Set<string>()
  return spaces
    .flatMap(space => space.tasks.map(task => ({ space, task, binding: expertTaskBinding(task) })))
    .filter(({ task, binding }) => {
      if (
        !isExpertConversation(task) ||
        (scope.expertId && binding?.definition.id !== scope.expertId)
      )
        return false
      if (
        scope.channelId &&
        expertTaskChannelId(task) !== scope.channelId
      )
        return false
      const key = task.threadId ?? task.taskId
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
