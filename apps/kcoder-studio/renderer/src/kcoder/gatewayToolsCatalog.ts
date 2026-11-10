import { captureAccountContextRevision } from './accountContextEvents'
import { studioPresentationParams } from './studioPresentation'
import { readStudioWorkMode } from '@/features/workbench/studioWorkMode'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { record, text } from './gateway/runtime/contracts'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import type { GatewayClient } from './gatewayRuntimeTypes'

/** A resident catalog belongs to its ready task client, including during reconnection. */
export async function requestToolsCatalog(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
) {
  const accountCurrent = captureAccountContextRevision()
  const address = record(params.address)
  const taskId = text(params.taskId) ?? text(address.taskId)
  if (text(params.taskId) && text(address.taskId) && params.taskId !== address.taskId)
    throw new Error('Tools catalog task identities disagree')
  const descriptor = taskId ? await this.taskDescriptor({ taskId }) : null
  const serverId = text(params.serverId)
  const requestedThread = text(params.threadId) ?? text(address.threadId)
  if (!descriptor) {
    if (!serverId) throw new Error('A tools catalog target is required')
    if (requestedThread) throw new Error('A task identity is required for a resident tools catalog')
    const target = await this.serverForParams({ deviceId: serverId })
    return this.withTransientClient(
      target,
      async client => {
        if (!accountCurrent(target.id)) throw new Error('Tools catalog target account changed')
        if (client.supportsExperimental?.('toolsCatalog') !== true) return null
        const result = await client.request(
          'tools/catalog',
          studioPresentationParams(readStudioWorkMode(), client)
        )
        if (!accountCurrent(target.id)) throw new Error('Tools catalog target account changed')
        return result
      },
      text(params.workspacePath) ?? target.workspacePath
    )
  }
  const { task, server } = descriptor
  if (serverId && serverId !== server.id)
    throw new Error('Tools catalog target does not match the task')
  if (
    (requestedThread && requestedThread !== task.threadId) ||
    (text(params.workspacePath) &&
      !sameWorkspacePath(text(params.workspacePath), task.workspacePath))
  )
    throw new Error('Tools catalog scope does not match the task')
  const key = task.taskId
  const threadId = task.threadId
  const workspacePath = task.workspacePath
  const targetId = server.id
  // Presentation alone must not activate arbitrary cold historical sessions.
  if (
    !this.clientByTask.has(key) &&
    !this.resumeClientByTask.has(key) &&
    !this.disconnectRecoveryByTask.has(key)
  )
    throw new Error('Tools catalog task is not resident')
  const client: GatewayClient = await this.readyTaskClient(task)
  const assertCurrent = () => {
    const current = this.tasks.get(key)
    if (
      this.disposed ||
      !accountCurrent(targetId) ||
      current?.threadId !== threadId ||
      current.serverId !== targetId ||
      !sameWorkspacePath(current.workspacePath, workspacePath) ||
      this.clientByTask.get(key) !== client ||
      this.disconnectRecoveryByTask.has(key)
    )
      throw new Error('Tools catalog task ownership changed')
  }
  assertCurrent()
  if (client.supportsExperimental?.('toolsCatalog') !== true) return null
  const result = await client.request('tools/catalog', {
    threadId,
    ...studioPresentationParams(task.studioWorkMode, client),
  })
  assertCurrent()
  return result
}
