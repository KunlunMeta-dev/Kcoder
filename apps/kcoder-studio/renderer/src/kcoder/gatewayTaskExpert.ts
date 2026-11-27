import { captureAccountContextRevision } from './accountContextEvents'
import { isContract } from '../../../shared/generated/validator.mjs'
import { isThreadExpertResult } from '../../../shared/generated/contractGuards.mjs'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { text, type GatewayTask } from './gateway/runtime/contracts'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import { sharePendingRead, type PendingRead } from '@/lib/pendingRead'
import type { ThreadExpertResult } from '../../../shared/generated/contracts'
import { isThreadMaintenanceBusy, requestResidentTaskRpc } from './gateway/runtime/threadResidency'

interface ExpertReads {
  assertOwner: () => GatewayTask
  pending: Map<string, PendingRead<ThreadExpertResult>>
}
const readsByRuntime = new WeakMap<GatewayRuntimeCore, Map<string, ExpertReads>>()

/** Resolve the original task connection; changing an expert never creates another thread. */
export async function requestTaskExpert(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<unknown> {
  options?.signal?.throwIfAborted()
  const deviceId = text(params.deviceId), expectedThreadId = text(params.threadId)
  if (!deviceId || !text(params.taskId) || (params.change !== undefined && !expectedThreadId))
    throw new Error('AGENT_ORIGINAL_TASK_REQUIRED')
  const account = captureAccountContextRevision(), generation = this.workspaceScanGeneration
  const { task, server, taskId } = await this.taskDescriptor(params)
  const threadId = text(task.threadId)
  if (!threadId || server.id !== deviceId || task.serverId !== deviceId ||
    (expectedThreadId && expectedThreadId !== threadId) ||
    (typeof params.workspacePath === 'string' && !sameWorkspacePath(params.workspacePath, task.workspacePath)))
    throw new Error('AGENT_ORIGINAL_TASK_CHANGED')
  options?.signal?.throwIfAborted()
  const client = await this.readyTaskClient(task)
  const assertOwner = () => {
    const current = this.tasks.get(taskId)
    if (this.disposed || this.workspaceScanGeneration !== generation || !account(deviceId) ||
      server.id !== deviceId || task.threadId !== threadId || current?.threadId !== threadId ||
      current.serverId !== deviceId || !sameWorkspacePath(current.workspacePath, task.workspacePath) ||
      (typeof params.workspacePath === 'string' && !sameWorkspacePath(params.workspacePath, task.workspacePath)))
      throw new Error('AGENT_ORIGINAL_TASK_CHANGED')
    // A reconnect replaces only the transport of the same original task. Its
    // reply is still discarded, but a later read on the new connection is valid.
    if (this.clientByTask.get(taskId) !== client) throw new Error('AGENT_TASK_CONNECTION_CHANGED')
    return current
  }
  const check = () => { options?.signal?.throwIfAborted(); return assertOwner() }
  check()
  if (client.supportsExperimental?.('agentTurnConfigurationV1') !== true)
    throw new Error('AGENT_TURN_CONFIGURATION_UNSUPPORTED')
  const wire = {
    threadId,
    ...(client.supportsExperimental?.('threadExpertReadWithoutTurnsV1') === true ? { includeTurns: false } : {}),
    ...(params.change === undefined ? {} : { change: params.change }),
  }
  if (!isContract('ThreadExpertParams', wire)) throw new Error('AGENT_CONFIGURATION_INVALID')
  // A read is served from persisted state; a change on an evicted thread is
  // rejected before mutation and resent once after re-activation (it is
  // revision-checked). A change during the same thread's compaction/rollback is
  // rejected before mutation and stays safe to retry later.
  const send = async (requestOptions: { signal?: AbortSignal } | undefined) => {
    try {
      return await requestResidentTaskRpc(this, task, client, 'thread/expert', wire, {
        ...requestOptions,
        assertCurrent: assertOwner,
      })
    } catch (error) {
      if (isThreadMaintenanceBusy(error)) throw new Error('AGENT_TASK_APP_SERVER_BUSY', { cause: error })
      throw error
    }
  }
  const reads = readsByRuntime.get(this) ?? new Map<string, ExpertReads>()
  readsByRuntime.set(this, reads)
  const apply = (result: unknown, scope?: ExpertReads): ThreadExpertResult => {
    const current = scope ? scope.assertOwner() : assertOwner()
    if (!isThreadExpertResult(result) || result.threadId !== threadId)
      throw new Error('AGENT_ORIGINAL_RESPONSE_REQUIRED')
    this.tasks.set(taskId, { ...current, agentDefinition: result.expert ?? undefined,
      runtimeHandle: { ...current.runtimeHandle, agentDefinition: result.expert ?? undefined } })
    return result
  }
  if (params.change !== undefined) {
    // Reads spanning either side of a mutation cannot project its older selection.
    reads.delete(taskId)
    try {
      const result = await send(options)
      options?.signal?.throwIfAborted()
      return apply(result)
    } finally { reads.delete(taskId) }
  }
  let scope = reads.get(taskId)
  try { scope?.assertOwner() } catch { scope = undefined }
  if (!scope || scope.pending.size === 0) {
    scope = { assertOwner: () => {
      const current = assertOwner()
      if (reads.get(taskId) !== scope) throw new Error('AGENT_CONFIGURATION_STALE_REPLY')
      return current
    }, pending: new Map() }
    reads.set(taskId, scope)
  }
  const currentScope = scope
  try {
    const result = await sharePendingRead(scope.pending, threadId, options?.signal, async signal => {
      currentScope.assertOwner()
      const result = await send({ signal })
      signal.throwIfAborted()
      return apply(result, currentScope)
    })
    check()
    return structuredClone(result)
  } finally {
    if (scope.pending.size === 0 && reads.get(taskId) === scope) reads.delete(taskId)
  }
}
