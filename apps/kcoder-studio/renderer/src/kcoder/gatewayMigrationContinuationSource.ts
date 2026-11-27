import { isMigrationContinuationSourceParams } from '../../../shared/generated/contractGuards.mjs'
import { captureAccountContextRevision } from './accountContextEvents'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { record, text, type GatewayTask } from './gateway/runtime/contracts'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import type { GatewayClient } from './gatewayRuntimeTypes'
import { GatewayRpcError, type GatewayServer } from './gatewayRpc'

interface SourceTask {
  key: string
  task: GatewayTask
  workspace: string
}

/** Provenance is an observation of the selected thread, never authority to acquire a cold task. */
export async function continuationSourceClient(
  core: GatewayRuntimeCore,
  target: GatewayServer,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<{ client: GatewayClient; assertCurrent: () => void }> {
  if (!isMigrationContinuationSourceParams(params.params))
    throw new Error('migration_invalid_parameters')
  const threadId = text(record(params.params).threadId)
  const requestedWorkspace = text(params.workspacePath)
  if (!threadId || (params.workspacePath != null && !requestedWorkspace))
    throw new Error('migration_invalid_parameters')
  const accountCurrent = captureAccountContextRevision()
  const threadKey = core.threadKey(target.id, threadId)
  const changed = () => new GatewayRpcError('migration_scope_changed', -32049, { kind: 'migration_scope_changed' })
  const assertAccount = () => {
    options?.signal?.throwIfAborted()
    if (core.disposed || !accountCurrent(target.id)) throw changed()
  }
  const lookup = (): SourceTask | null => {
    assertAccount()
    const key = core.taskByThread.get(threadKey)
    if (!key) return null
    const task = core.tasks.get(key)
    if (!task || task.taskId !== key || task.serverId !== target.id || task.threadId !== threadId)
      throw changed()
    if (requestedWorkspace && !sameWorkspacePath(requestedWorkspace, task.workspacePath))
      throw new Error('migration_continuation_source_workspace_changed')
    return { key, task, workspace: task.workspacePath }
  }
  const resident = (source: SourceTask | null) => Boolean(source && (
    core.clientByTask.has(source.key) || core.resumeClientByTask.has(source.key) ||
    core.disconnectRecoveryByTask.has(source.key)
  ))
  const assertTask = (source: SourceTask | null) => {
    const current = lookup()
    if (source === null ? current !== null : !current || current.key !== source.key ||
      !sameWorkspacePath(current.workspace, source.workspace))
      throw changed()
  }
  const owned = async (source: SourceTask) => {
    const client = await core.readyTaskClient(source.task)
    const assertCurrent = () => {
      assertTask(source)
      if (core.clientByTask.get(source.key) !== client || core.disconnectRecoveryByTask.has(source.key))
        throw changed()
    }
    assertCurrent()
    return { client, assertCurrent }
  }

  let source = lookup()
  if (source && resident(source)) return owned(source)
  const workspace = requestedWorkspace ?? source?.workspace ?? target.workspacePath
  const client = await core.commandClient(target, workspace)
  assertAccount()
  // A normal UI resume may finish while the command channel is connecting.
  // Reconcile before sending; never provoke an owner denial and retry elsewhere.
  const current = lookup()
  if (source) assertTask(source)
  if (current && resident(current)) return owned(current)
  source = current
  if (source && !sameWorkspacePath(source.workspace, workspace)) throw changed()
  const selected = source
  const assertCurrent = () => {
    assertTask(selected)
    if (resident(lookup())) throw changed()
  }
  assertCurrent()
  return { client, assertCurrent }
}
