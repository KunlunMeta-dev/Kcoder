import { captureAccountContextRevision } from './accountContextEvents'
import { isContract } from '../../../shared/generated/validator.mjs'
import { isThreadExpertResult } from '../../../shared/generated/contractGuards.mjs'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { record, text } from './gateway/runtime/contracts'
import type { GatewayRuntimeCore } from './gateway/runtime/core'

/** Resolve the original task connection; changing an expert never creates another thread. */
export async function requestTaskExpert(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<unknown> {
  const deviceId = text(params.deviceId), threadId = text(params.threadId)
  if (!deviceId || !threadId || !text(params.taskId)) throw new Error('AGENT_ORIGINAL_TASK_REQUIRED')
  const account = captureAccountContextRevision(), generation = this.workspaceScanGeneration
  const { task, server, client, taskId } = await this.taskConnection(params)
  const check = () => {
    options?.signal?.throwIfAborted()
    const current = this.tasks.get(taskId)
    if (this.disposed || this.workspaceScanGeneration !== generation || !account(deviceId) ||
      server.id !== deviceId || task.threadId !== threadId || current?.threadId !== threadId ||
      current.serverId !== deviceId || current.workspacePath !== task.workspacePath ||
      (typeof params.workspacePath === 'string' && !sameWorkspacePath(params.workspacePath, task.workspacePath)) ||
      this.clientByTask.get(taskId) !== client) throw new Error('AGENT_ORIGINAL_TASK_CHANGED')
  }
  check()
  if (client.supportsExperimental?.('agentTurnConfigurationV1') !== true)
    throw new Error('AGENT_TURN_CONFIGURATION_UNSUPPORTED')
  const wire = { threadId, ...(params.change === undefined ? {} : { change: params.change }) }
  if (!isContract('ThreadExpertParams', wire)) throw new Error('AGENT_CONFIGURATION_INVALID')
  const result = await client.request('thread/expert', wire, options)
  check()
  if (!isThreadExpertResult(result) || record(result).threadId !== threadId)
    throw new Error('AGENT_ORIGINAL_RESPONSE_REQUIRED')
  this.tasks.set(taskId, { ...task, agentDefinition: result.expert ?? undefined,
    runtimeHandle: { ...task.runtimeHandle, agentDefinition: result.expert ?? undefined } })
  return result
}
