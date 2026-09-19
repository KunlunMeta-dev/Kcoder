import type { RuntimeTaskAddress, RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'

export function isFailedRuntimeDraft(task: RuntimeTaskSummary): boolean {
  return task.optimistic === true && task.status === 'failed' && !task.running &&
    !task.threadId && !task.taskId.includes(':') &&
    !['threadId', 'thread_id', 'sessionId', 'session_id'].some(key => task.runtimeHandle?.[key])
}

export function findFailedRuntimeDraft(work: RuntimeWorkListResponse | null, address: RuntimeTaskAddress) {
  const workspaces = [...(work?.projects.flatMap(project => project.deviceWorkspaces) ?? []), ...(work?.chats ?? [])]
  return workspaces.filter(workspace => workspace.deviceId === address.deviceId &&
    (!address.workspacePath || workspace.workspacePath === address.workspacePath))
    .flatMap(workspace => workspace.tasks).find(task => task.taskId === address.taskId && isFailedRuntimeDraft(task))
}
