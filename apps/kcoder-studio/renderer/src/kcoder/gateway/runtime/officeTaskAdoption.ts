import { isIntegrationRuntimeAcceptance } from '../../../../../shared/generated/contractGuards.mjs'
import { notifyRuntimeWorkChanged } from '../../runtimeWorkEvents'
import { projectRuntimeAcceptanceActivity } from '@/features/workbench/runtimeTaskLifecycle/workListProjection'
import type { GatewayServer } from '../../gatewayRpc'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import type { IntegrationReply } from '../../../../../shared/generated/contracts'
import { record, runtimeTaskId, text, type GatewayTask } from './contracts'
import type { GatewayRuntimeCore } from './core'

/** Reuse the existing notification barrier so an early approval cannot precede task registration. */
export function holdOfficeTaskNotifications(core: GatewayRuntimeCore, client: GatewayClient) {
  const preceding = core.notificationQueueByClient.get(client) ?? Promise.resolve()
  let release!: () => void
  const admission = new Promise<void>(resolve => {
    release = resolve
  })
  core.notificationQueueByClient.set(
    client,
    preceding.then(() => admission)
  )
  return release
}

/** Native acceptance identifies a task; this projection grants no permission and sends no turn. */
export function registerOfficeTask(
  core: GatewayRuntimeCore,
  server: GatewayServer,
  client: GatewayClient,
  workspacePath: string | undefined,
  request: Record<string, unknown>,
  reply: IntegrationReply
) {
  const acceptance = record(reply.result).nativeTask
  if (
    !['accepted', 'completed'].includes(reply.status) ||
    reply.error !== null ||
    !isIntegrationRuntimeAcceptance(acceptance) ||
    !acceptance.threadId ||
    !acceptance.turnId ||
    acceptance.state === 'outcome_unknown'
  )
    return
  const taskId = runtimeTaskId(server, acceptance.threadId)
  const threadKey = core.threadKey(server.id, acceptance.threadId)
  const oldTaskId = core.taskByThread.get(threadKey)
  const oldClient = core.clientByTask.get(taskId)
  if ((oldTaskId && oldTaskId !== taskId) || (oldClient && oldClient !== client))
    throw new Error('INTEGRATION_TASK_OWNER_CHANGED')
  const previous = core.tasks.get(taskId)
  const now = Date.now()
  const inputs = record(record(request.payload).inputs)
  const task: GatewayTask = previous ?? {
    serverId: server.id,
    taskId,
    threadId: acceptance.threadId,
    workspacePath: workspacePath ?? server.workspacePath ?? '',
    title: Array.from(text(inputs.title) ?? text(inputs.request) ?? 'Office')
      .slice(0, 120)
      .join(''),
    runtime: 'kcoder',
    persisted: true,
    running: true,
    createdAt: now,
    updatedAt: now,
    studioWorkMode: 'kworker',
    runtimeHandle: { threadId: acceptance.threadId, studioWorkMode: 'kworker' },
  }
  task.updatedAt = now
  core.tasks.set(taskId, projectRuntimeAcceptanceActivity(task, acceptance.state))
  core.threadByTask.set(taskId, acceptance.threadId)
  core.taskByThread.set(threadKey, taskId)
  if (!oldClient) core.bindTaskClient(taskId, client)
  notifyRuntimeWorkChanged()
}
