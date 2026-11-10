import { computerUseStates } from '../../computerUseState'
import { taskConnectionStatus } from '../../taskConnectionStatus'
import { restartOwnedAppServers } from '../../gatewayAppServerRestart'
import { emitRuntimeEvent as emit } from '../../gatewayServiceBridge'
import { safeGatewayFailureDiagnostic } from '../../gatewayRpc'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { EXECUTOR_EVENT, record, text } from './contracts'
import type { GatewayRuntimeCore } from './core'

export function isRestartingServer(this: GatewayRuntimeCore, serverId: string): boolean {
  return (
    this.restartingAppServers &&
    (this.restartingServerId === null || this.restartingServerId === serverId)
  )
}

export async function assertRequestTargetAvailable(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
): Promise<void> {
  if (this.restartingServerId === null) throw new Error('KCoder app-server restart is in progress')
  const address = record(params.address)
  const taskId = this.resolveTaskId(text(params.taskId) ?? text(address.taskId))
  const task = taskId ? (this.tasks.get(taskId) ?? this.archivedTasks.get(taskId)) : undefined
  // Task-owned requests need not repeat their device ID; keep their authoritative routing.
  if (task && this.isRestartingServer(task.serverId))
    throw new Error('KCoder app-server restart is in progress')
  const target = await this.serverForParams({
    ...params,
    deviceId:
      text(params.serverId) ?? text(params.deviceId) ?? text(address.deviceId) ?? task?.serverId,
    workspacePath: text(params.workspacePath) ?? text(address.workspacePath),
  })
  if (this.isRestartingServer(target.id))
    throw new Error('KCoder app-server restart is in progress')
}

export async function restartAppServers(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  if (this.restartingAppServers) throw new Error('KCoder app-server restart is in progress')
  const activeTaskIds = new Set(this.activeTurnByTask.keys())
  for (const job of this.backgroundJobById.values()) activeTaskIds.add(job.taskId)
  const selectedServerId = text(params.serverId)
  const activeTaskCount = [...activeTaskIds].filter(taskId => {
    const task = this.tasks.get(taskId)
    return !selectedServerId || !task || task.serverId === selectedServerId
  }).length
  const connections = [...this.connectionsByClient.values()].filter(
    connection => !selectedServerId || connection.serverId === selectedServerId
  )
  if (
    connections.some(connection => connection.channel === 'browser') ||
    (params.ifIdle === true && params.force !== true && activeTaskCount > 0)
  ) {
    return { restarted: false, requiresConfirmation: true, activeTaskCount }
  }
  const questionOwners = [...this.tasks.values()]
    .filter(task => connections.some(connection =>
      connection.client === this.clientByTask.get(task.taskId)))
    .map(task => ({ taskId: task.taskId, serverId: task.serverId,
      threadId: task.threadId, workspacePath: task.workspacePath }))
  let result: Awaited<ReturnType<typeof restartOwnedAppServers>>
  this.restartingServerId = selectedServerId
  this.restartingAppServers = true
  try {
    result = await restartOwnedAppServers(
      connections,
      params.force === true,
      client => this.releaseClient(client),
      (server, workspacePath) => this.connectClient(server, 'runtime', workspacePath, true)
    )
  } finally {
    this.restartingAppServers = false
    this.restartingServerId = null
  }
  // Restart suppresses automatic disconnect recovery. Reconcile mounted cards
  // only after initialize succeeds and the request barrier has been released.
  if (result.restarted) {
    for (const owner of questionOwners) {
      const task = this.tasks.get(owner.taskId)
      if (this.disposed || task?.serverId !== owner.serverId ||
          task.threadId !== owner.threadId ||
          !sameWorkspacePath(task.workspacePath, owner.workspacePath)) continue
      await emit(EXECUTOR_EVENT, { event: 'async-question:refresh', payload: owner })
        .catch(error => console.warn('[KCoder] 无法刷新重启任务的提问状态', safeGatewayFailureDiagnostic(error)))
    }
  }
  return { ...result, activeTaskCount }
}

/** Invalidate cached references before the transport's asynchronous close event. */
export function unregisterClient(this: GatewayRuntimeCore, client: GatewayClient) {
  const connection = this.connectionsByClient.get(client)
  if (!connection) return
  this.connectionsByClient.delete(client)
  connection.onClose?.()
}

/** Retire a locally owned transport; business maps remain lookup indexes. */
export function releaseClient(this: GatewayRuntimeCore, client: GatewayClient) {
  if (!this.connectionsByClient.has(client)) return
  for (const [taskId, taskClient] of this.clientByTask) {
    if (taskClient !== client) continue
    this.clientByTask.delete(taskId)
    this.resumeClientByTask.delete(taskId)
    this.activeTurnByTask.get(taskId)?.complete()
    this.activeTurnByTask.delete(taskId)
    const task = this.tasks.get(taskId)
    if (task) computerUseStates.unconfirmed(this, task.serverId, taskId)
    if (task) this.tasks.set(taskId, { ...task, running: false, updatedAt: Date.now() })
    for (const [jobId, job] of this.backgroundJobById) {
      if (job.taskId === taskId) this.backgroundJobById.delete(jobId, job)
    }
  }
  try {
    this.unregisterClient(client)
  } finally {
    client.close()
  }
}

export function invalidateWorkspaceScans(this: GatewayRuntimeCore) {
  this.workspaceScanGeneration += 1
  this.taskListScans.invalidate()
  for (const connection of this.connectionsByClient.values()) {
    if (connection.scanBound) this.releaseClient(connection.client)
  }
}

export function dispose(this: GatewayRuntimeCore) {
  if (this.disposed) return
  this.disposed = true
  for (const observer of this.turnReceiptObservers.values()) observer.abort()
  this.turnReceiptObservers.clear()
  computerUseStates.dispose(this)
  taskConnectionStatus.dispose(this)
  this.turnAttemptIds.clear()
  this.toolPathPreviews.dispose()
  this.invalidateWorkspaceScans()
  if (typeof window !== 'undefined') {
    window.removeEventListener('kcoder:servers-changed', this.handleServersChanged)
    this.stopAccountContextListener()
  }
  this.trackAsyncJob(this.browserRuntime.dispose().finally(() => {
    for (const connection of this.connectionsByClient.values()) this.releaseClient(connection.client)
  }))
  for (const connection of this.connectionsByClient.values()) {
    if (connection.channel === 'runtime') this.releaseClient(connection.client)
  }
  for (const stream of this.agentConversationSubscriptions.values()) stream.removeCloseListener?.()
  this.agentConversationSubscriptions.clear()
  this.clientByTask.clear()
  this.taskViewGenerations.clear()
  this.pendingTaskInputs.clear()
  this.canonicalTaskByRequested.clear()
  this.persistedThreadMisses.clear()
  this.resumeClientByTask.clear()
  this.commandClientByServer.clear()
  this.commandClientScopeByKey.clear()
  this.controlClientPromise = null
  this.remoteSessions.dispose()
  for (const pending of this.pendingQuestionByKey.values()) {
    if (pending.autoResolutionTimer !== undefined) window.clearTimeout(pending.autoResolutionTimer)
  }
  this.pendingQuestionByKey.clear()
  this.toolNameByCall.clear()
  this.backgroundJobById.clear()
  this.interruptedBackgroundToolByKey.clear()
}

export async function disposeAsync(this: GatewayRuntimeCore): Promise<void> {
  this.dispose()
  while (this.pendingAsyncJobs.size > 0) {
    await Promise.all([...this.pendingAsyncJobs])
  }
}
