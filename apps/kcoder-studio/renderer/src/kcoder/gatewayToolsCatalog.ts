import { captureAccountContextRevision } from './accountContextEvents'
import { studioPresentationParams } from './studioPresentation'
import { readStudioWorkMode } from '@/features/workbench/studioWorkMode'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { record, text } from './gateway/runtime/contracts'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import type { GatewayClient } from './gatewayRuntimeTypes'
import { requestResidentTaskRpc } from './gateway/runtime/threadResidency'

/** Catalog acquisition differs by residency; read ownership and publication do not. */
export async function requestToolsCatalog(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
) {
  const accountCurrent = captureAccountContextRevision()
  const address = record(params.address)
  const taskId = text(params.taskId) ?? text(address.taskId)
  if (text(params.taskId) && text(address.taskId) && params.taskId !== address.taskId)
    throw new Error('Tools catalog task identities disagree')
  const serverId = text(params.serverId) ?? text(address.deviceId)
  const requestedTargetId = serverId ?? this.tasks.get(this.resolveTaskId(taskId) ?? '')?.serverId
  const requestedConfiguration = this.configurationEpochByTarget.get(requestedTargetId ?? '')
  const descriptor = taskId ? await this.taskDescriptor(params) : null
  if (!descriptor) {
    if (!serverId) throw new Error('A tools catalog target is required')
    if (text(params.threadId) || text(address.threadId))
      throw new Error('A task identity is required for a resident tools catalog')
  }
  const target = descriptor?.server ?? await this.serverForParams({ deviceId: serverId })
  const task = descriptor?.task
  const targetId = target.id
  const key = task?.taskId
  const threadId = task?.threadId
  const workspacePath = task?.workspacePath ?? text(params.workspacePath) ?? text(address.workspacePath) ?? target.workspacePath
  if ([params.serverId, address.deviceId].map(text).some(id => id && id !== targetId))
    throw new Error('Tools catalog target does not match the task')
  if ([params.threadId, address.threadId].map(text).some(id => id && id !== threadId) ||
      [params.workspacePath, address.workspacePath].map(text).some(path => path && !sameWorkspacePath(path, workspacePath)))
    throw new Error('Tools catalog scope does not match the task')
  const configuration = requestedTargetId ? requestedConfiguration : this.configurationEpochByTarget.get(targetId)
  const assertSource = () => {
    if (this.disposed || !accountCurrent(targetId) ||
        this.configurationEpochByTarget.get(targetId) !== configuration)
      throw new Error('Tools catalog ownership changed')
  }
  assertSource()
  const readCatalog = async (client: GatewayClient) => {
    const connection = client.diagnosticConnection?.connectionId
    const assertCurrent = () => {
      const current = key ? this.tasks.get(key) : undefined
      assertSource()
      if (client.diagnosticConnection?.connectionId !== connection ||
          this.appServerDisconnectedClients.has(client) ||
          key && (this.resolveTaskId(taskId) !== key || !current ||
            current.threadId !== threadId || current.serverId !== targetId ||
            !sameWorkspacePath(current.workspacePath, workspacePath) ||
            this.clientByTask.get(key) !== client || this.disconnectRecoveryByTask.has(key)))
        throw new Error('Tools catalog ownership changed')
    }
    assertCurrent()
    if (client.supportsExperimental?.('toolsCatalog') !== true) return null
    try {
      const fields = studioPresentationParams(task ? task.studioWorkMode : readStudioWorkMode(), client)
      return task
        ? await requestResidentTaskRpc(this, task, client, 'tools/catalog', fields, { assertCurrent })
        : await client.request('tools/catalog', fields)
    } finally {
      assertCurrent()
    }
  }
  if (!task) return this.withTransientClient(target, readCatalog, workspacePath)
  // Presentation alone must not activate arbitrary cold historical sessions.
  if (!this.clientByTask.has(task.taskId) && !this.resumeClientByTask.has(task.taskId) &&
      !this.disconnectRecoveryByTask.has(task.taskId))
    throw new Error('Tools catalog task is not resident')
  return readCatalog(await this.readyTaskClient(task))
}
