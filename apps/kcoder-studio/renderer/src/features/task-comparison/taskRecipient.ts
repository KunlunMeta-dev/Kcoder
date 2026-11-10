import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import { findRuntimeTask } from '@/features/workbench/workbenchRuntimeHelpers'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { runtimeThreadId } from '@/features/workbench/useWorkbenchRuntimeMessaging'

/** A draft target comes from the current task catalog, never a task-id convention. */
export function knownTaskRecipient(
  work: RuntimeWorkListResponse | null | undefined,
  address: RuntimeTaskAddress
): RuntimeTaskAddress | null {
  const task = findRuntimeTask(work, address)
  const expected = runtimeThreadId(address)
  const actual = task
    ? runtimeThreadId({
        deviceId: address.deviceId,
        taskId: task.taskId,
        threadId: task.threadId,
        runtimeHandle: task.runtimeHandle,
      })
    : null
  if (
    !task ||
    !expected ||
    actual !== expected ||
    !task.workspacePath ||
    (address.workspacePath && !sameWorkspacePath(address.workspacePath, task.workspacePath))
  )
    return null
  return {
    deviceId: address.deviceId,
    taskId: task.taskId,
    threadId: actual,
    workspacePath: task.workspacePath,
    runtimeHandle: task.runtimeHandle,
  }
}
