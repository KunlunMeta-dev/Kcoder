import { getRuntimeTaskWorkspacePath } from '@/features/workbench/workbenchRuntimeHelpers'
import type { RuntimeDeviceWorkspace, RuntimeTaskAddress } from '@/types/api'
import type { TaskWorkspaceNativeRef } from '../../../../shared/generated/contracts'
import type { TaskWorkspaceTarget } from '@/kcoder/taskWorkspaceTransport'

/** Resolve only an existing original thread address; never derive a client alias. */
export function nativeThreadAddress(
  workspaces: readonly RuntimeDeviceWorkspace[],
  target: TaskWorkspaceTarget,
  reference: TaskWorkspaceNativeRef
): RuntimeTaskAddress | undefined {
  if (reference.kind !== 'thread' || !target.serverId) return
  const matches = new Map<string, RuntimeTaskAddress>()
  for (const workspace of workspaces) {
    if (workspace.deviceId !== target.serverId) continue
    for (const task of workspace.tasks) {
      if (task.threadId !== reference.threadId || !task.taskId) continue
      const workspacePath = getRuntimeTaskWorkspacePath(workspace, task)
      if (target.workspacePath !== undefined && workspacePath !== target.workspacePath) continue
      const address: RuntimeTaskAddress = {
        deviceId: workspace.deviceId,
        taskId: task.taskId,
        threadId: task.threadId,
        workspacePath,
        ...(task.runtimeHandle ? { runtimeHandle: structuredClone(task.runtimeHandle) } : {}),
      }
      matches.set(JSON.stringify(address), address)
    }
  }
  return matches.size === 1 ? matches.values().next().value : undefined
}
