import i18n from '@/i18n'
import { captureAccountContextRevision } from './accountContextEvents'
import { record, text } from './gateway/runtime/contracts'
import type { GatewayRuntimeCore } from './gateway/runtime/core'

const methods = new Set(['task/delivery/prepare', 'task/delivery/read', 'task/delivery/request', 'task/delivery/failure'])

/** Bind delivery to the explicitly addressed task before and after each target await. */
export async function requestTaskDelivery(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<unknown> {
  const method = text(params.method)
  if (method !== 'capabilities' && !methods.has(method ?? ''))
    throw new Error(i18n.t('taskDelivery:failed'))
  const taskId = text(params.taskId)
  const threadId = text(params.threadId)
  const deviceId = text(params.deviceId)
  if (!taskId || !threadId || !deviceId) throw new Error(i18n.t('taskDelivery:originalUnavailable'))
  const accountValid = captureAccountContextRevision()
  const ownerGeneration = this.workspaceScanGeneration
  const { task, server, client, taskId: resolvedTaskId } = await this.taskConnection(params)
  const assertCurrent = () => {
    options?.signal?.throwIfAborted()
    const current = this.tasks.get(resolvedTaskId)
    if (this.disposed || this.workspaceScanGeneration !== ownerGeneration || !accountValid(deviceId) || server.id !== deviceId || task.threadId !== threadId ||
      current?.threadId !== threadId || current.serverId !== deviceId ||
      current.workspacePath !== task.workspacePath || this.clientByTask.get(resolvedTaskId) !== client)
      throw new Error(i18n.t('taskDelivery:originalUnavailable'))
  }
  assertCurrent()
  const supported = client.supportsExperimental?.('taskDeliveryV1') === true
  if (method === 'capabilities') return { supported }
  if (!supported) throw new Error(i18n.t('taskDelivery:unsupported'))
  const wire: Record<string, unknown> = { threadId, owner: { taskId: resolvedTaskId, threadId: task.threadId, deviceId: server.id } }
  if (method === 'task/delivery/prepare') {
    wire.baseBranch = params.baseBranch
    if (params.comparisonId !== undefined) wire.comparisonId = params.comparisonId
  } else {
    wire.deliveryId = params.deliveryId
    if (method === 'task/delivery/request') {
      wire.requestId = params.requestId
      wire.title = params.title
      wire.body = params.body
    } else if (method === 'task/delivery/failure') wire.checkId = params.checkId
  }
  const result = await client.request(method!, wire, options)
  assertCurrent()
  const resultOwner = text(record(result).threadId)
  if (resultOwner !== threadId) throw new Error(i18n.t('taskDelivery:originalUnavailable'))
  return result
}
