import type { RuntimeTaskAddress } from '@/types/api'

export interface ExpertConversationScope {
  deviceId: string
  workspacePath: string
  expertId?: string
  channelId?: string
}

export function expertConversationRoute(scope: ExpertConversationScope, task?: RuntimeTaskAddress) {
  const query = new URLSearchParams({
    deviceId: scope.deviceId,
    workspacePath: scope.workspacePath,
  })
  if (scope.expertId) query.set('expertId', scope.expertId)
  if (scope.channelId) query.set('channelId', scope.channelId)
  if (task) query.set('taskId', task.taskId)
  return `/expert-conversations?${query}`
}

export function readExpertConversationScope(search: string): ExpertConversationScope | null {
  const query = new URLSearchParams(search)
  const deviceId = query.get('deviceId')
  const workspacePath = query.get('workspacePath')
  if (!deviceId || !workspacePath) return null
  return {
    deviceId,
    workspacePath,
    expertId: query.get('expertId') ?? undefined,
    channelId: query.get('channelId') ?? undefined,
  }
}
