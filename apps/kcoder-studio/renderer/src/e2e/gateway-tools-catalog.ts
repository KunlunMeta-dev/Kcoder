import { getWorkbenchDebugSnapshot } from '@/lib/debugPanel'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import { gatewayVerificationConfig } from './gateway-verification'

function activeTask() {
  return getWorkbenchDebugSnapshot().workbench?.currentRuntimeTask ?? null
}

export async function getActiveToolsCatalog() {
  const verification = gatewayVerificationConfig()
  if (!verification) throw new Error('Gateway verification is not active')
  const task = activeTask()
  if (!task?.taskId || !task.deviceId) throw new Error('No active Gateway task')
  const identity = JSON.stringify([task.deviceId, task.taskId, task.threadId, task.workspacePath])
  const catalog = await requestLocalExecutor('runtime.tools.catalog', {
    taskId: task.taskId,
    serverId: task.deviceId,
  })
  const current = activeTask()
  if (
    gatewayVerificationConfig()?.origin !== verification.origin ||
    !current ||
    JSON.stringify([current.deviceId, current.taskId, current.threadId, current.workspacePath]) !==
      identity
  )
    throw new Error('Active Gateway task changed during catalog observation')
  return { taskId: task.taskId, serverId: task.deviceId, threadId: task.threadId, catalog }
}
