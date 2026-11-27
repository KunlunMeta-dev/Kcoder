import { captureAccountContextRevision } from './accountContextEvents'
import { hookTargetScope } from './gatewayHookConfiguration'
import { GatewayRpcError } from './gatewayRpc'
import { record, text } from './gateway/runtime/contracts'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import { requestResidentTaskRpc } from './gateway/runtime/threadResidency'
import {
  EVOLUTION_METHODS,
  EVOLUTION_SETTINGS_METHODS,
  SELF_EVOLUTION_CAPABILITY,
} from './evolution/evolutionContract'

const TARGET_METHODS = new Set<string>(Object.values(EVOLUTION_METHODS))
const SETTINGS_METHODS = new Set<string>(Object.values(EVOLUTION_SETTINGS_METHODS))

export function isEvolutionSettingsMethod(value: unknown): boolean {
  return typeof value === 'string' && SETTINGS_METHODS.has(value)
}

function unsupported(): GatewayRpcError {
  return new GatewayRpcError('Target does not support self-evolution', -32000, {
    kind: 'evolution_unsupported',
    capability: SELF_EVOLUTION_CAPABILITY,
  })
}

/** Resolve the command client and fence every await against target/account changes. */
async function targetClient(
  runtime: GatewayRuntimeCore,
  serverId: string,
  workspacePath: string | undefined,
  signal?: AbortSignal,
  expectedScope?: unknown
) {
  const accountCurrent = captureAccountContextRevision()
  const generation = runtime.configurationEpochByTarget.get(serverId)
  const check = () => {
    signal?.throwIfAborted()
    if (
      runtime.disposed ||
      runtime.configurationEpochByTarget.get(serverId) !== generation ||
      !accountCurrent(serverId)
    )
      throw new Error('EVOLUTION_TARGET_CHANGED')
  }
  check()
  const target = await runtime.serverForParams({ deviceId: serverId })
  const identity = hookTargetScope(target)
  if (expectedScope !== undefined && expectedScope !== identity)
    throw new Error('EVOLUTION_TARGET_CHANGED')
  await runtime.assertCommandTarget(target)
  check()
  const client = await runtime.commandClient(target, workspacePath)
  check()
  const assertCurrent = async () => {
    check()
    if (hookTargetScope(await runtime.serverForParams({ deviceId: serverId })) !== identity)
      throw new Error('EVOLUTION_TARGET_CHANGED')
    check()
  }
  return { client, assertCurrent }
}

/** Capability probe only; it never sends an evolution request to the target. */
export async function supportsEvolution(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<{ supported: boolean }> {
  const serverId = text(params.serverId)
  if (!serverId) throw new Error('EVOLUTION_TARGET_REQUIRED')
  const { client, assertCurrent } = await targetClient(
    this,
    serverId,
    text(params.workspacePath) ?? undefined,
    options?.signal,
    params.targetScope
  )
  await assertCurrent()
  return { supported: client.supportsExperimental?.(SELF_EVOLUTION_CAPABILITY) === true }
}

/**
 * Forwards one `evolution/*` or `settings/evolution/*` request to the selected
 * target after observing `selfEvolutionV1`. Ratings and the ratable-turn list
 * resolve the thread from the original task connection so a rating never lands
 * on (or is read from) another conversation.
 */
export async function requestEvolution(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<unknown> {
  const method = text(params.method)
  const serverId = text(params.serverId)
  const fields = structuredClone(record(params.params))
  if (!method || !(TARGET_METHODS.has(method) || SETTINGS_METHODS.has(method)))
    throw new Error('EVOLUTION_INVALID_REQUEST')
  if (!serverId) throw new Error('EVOLUTION_TARGET_REQUIRED')
  if (
    (method === EVOLUTION_SETTINGS_METHODS.read && Object.keys(fields).length > 0) ||
    (method === EVOLUTION_SETTINGS_METHODS.save &&
      (typeof fields.expectedRevision !== 'string' ||
        !fields.expectedRevision ||
        !fields.settings ||
        typeof fields.settings !== 'object' ||
        Array.isArray(fields.settings) ||
        Object.keys(fields).length !== 2))
  )
    throw new Error('EVOLUTION_INVALID_REQUEST')
  // Thread-scoped methods resolve the thread from the original task.
  if (method === EVOLUTION_METHODS.rate || method === EVOLUTION_METHODS.ratingsList) {
    const taskId = text(params.taskId)
    if (!taskId) throw new Error('EVOLUTION_TASK_REQUIRED')
    // The thread always comes from the original task, never from the caller.
    if ('threadId' in fields) throw new Error('EVOLUTION_INVALID_REQUEST')
    const accountCurrent = captureAccountContextRevision()
    const { task, server, client } = await this.taskConnection({ taskId, deviceId: serverId })
    const assertCurrent = () => {
      options?.signal?.throwIfAborted()
      const current = this.tasks.get(task.taskId)
      if (this.disposed || server.id !== serverId || !accountCurrent(serverId) || !task.threadId ||
          this.clientByTask.get(task.taskId) !== client || current?.threadId !== task.threadId ||
          current.serverId !== task.serverId)
        throw new Error('EVOLUTION_TASK_CHANGED')
    }
    assertCurrent()
    if (client.supportsExperimental?.(SELF_EVOLUTION_CAPABILITY) !== true) throw unsupported()
    const result = await requestResidentTaskRpc(this, task, client, method, fields, { ...options, assertCurrent })
    assertCurrent()
    return result
  }
  const { client, assertCurrent } = await targetClient(
    this,
    serverId,
    text(params.workspacePath) ?? undefined,
    options?.signal,
    params.targetScope
  )
  if (client.supportsExperimental?.(SELF_EVOLUTION_CAPABILITY) !== true) throw unsupported()
  const result = await client.request<unknown>(method, fields, options)
  await assertCurrent()
  return result
}
