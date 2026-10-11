import { computerUseStates } from '../../computerUseState'
import { restartOwnedAppServers } from '../../gatewayAppServerRestart'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { record, text } from './contracts'
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
  if (params.ifIdle === true && params.force !== true && activeTaskCount > 0) {
    return { restarted: false, requiresConfirmation: true, activeTaskCount }
  }
  this.restartingServerId = selectedServerId
  this.restartingAppServers = true
  try {
    const restarted = await restartOwnedAppServers(
      [...this.ownedRuntimeClients.values()].filter(
        target => !text(params.serverId) || target.server.id === text(params.serverId)
      ),
      params.force === true,
      client => this.releaseRestartClient(client),
      (server, workspacePath) => this.connectClient(server, 'runtime', workspacePath, true)
    )
    return { restarted, requiresConfirmation: false, activeTaskCount }
  } finally {
    this.restartingAppServers = false
    this.restartingServerId = null
  }
}

export async function releaseRestartClient(this: GatewayRuntimeCore, client: GatewayClient) {
  this.ownedRuntimeClients.delete(client)
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
  for (const [key, pending] of this.commandClientByServer) {
    if ((await pending) === client && this.commandClientByServer.get(key) === pending) {
      this.commandClientByServer.delete(key)
    }
  }
  const control = this.controlClientPromise
  if (control && (await control) === client && this.controlClientPromise === control) {
    this.controlClientPromise = null
  }
}

export function invalidateWorkspaceScans(this: GatewayRuntimeCore) {
  this.workspaceScanGeneration += 1
  this.taskListScans.invalidate()
  for (const client of this.transientClients) client.close()
  this.transientClients.clear()
}

export function dispose(this: GatewayRuntimeCore) {
  computerUseStates.dispose(this)
  this.turnAttemptIds.clear()
  if (this.disposed) return
  this.disposed = true
  this.toolPathPreviews.dispose()
  this.invalidateWorkspaceScans()
  if (typeof window !== 'undefined') {
    window.removeEventListener('kcoder:servers-changed', this.handleServersChanged)
    this.stopAccountContextListener()
  }
  this.trackAsyncJob(this.browserRuntime.dispose())
  for (const client of this.clientByTask.values()) client.close()
  for (const stream of this.agentConversationSubscriptions.values()) stream.removeCloseListener?.()
  this.agentConversationSubscriptions.clear()
  this.clientByTask.clear()
  this.canonicalTaskByRequested.clear()
  this.persistedThreadMisses.clear()
  this.resumeClientByTask.clear()
  for (const client of this.commandClientByServer.values()) {
    this.trackAsyncJob(client.then(value => value.close()))
  }
  this.commandClientByServer.clear()
  if (this.controlClientPromise) {
    this.trackAsyncJob(this.controlClientPromise.then(client => client.close()))
  }
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
