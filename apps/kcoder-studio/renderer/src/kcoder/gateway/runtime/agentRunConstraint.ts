import type { BackgroundRunKey } from '../../../../../shared/generated/contracts'
import { GatewayRpcError } from '../../gatewayRpc'
import { captureAccountContextRevision } from '../../accountContextEvents'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { record, text } from './contracts'
import type { GatewayRuntimeCore } from './core'
export function sameAgentRun(a: unknown, b: BackgroundRunKey): boolean {
  const value = record(a)
  return (
    value.parentSessionId === b.parentSessionId &&
    value.agentId === b.agentId &&
    value.runId === b.runId
  )
}
export function exactAgentUnavailable(): GatewayRpcError {
  return new GatewayRpcError(
    'agent_exact_run_unavailable',
    -32038,
    undefined,
    'runtime-session',
    'remote'
  )
}
export function requestedAgentRun(params: Record<string, unknown>): BackgroundRunKey | undefined {
  if (params.expectedBackgroundRun === undefined) return undefined
  const value = record(params.expectedBackgroundRun)
  if (
    Object.keys(value).sort().join(',') !== 'agentId,parentSessionId,runId' ||
    typeof value.parentSessionId !== 'string' ||
    !value.parentSessionId ||
    value.parentSessionId.length > 256 ||
    typeof value.agentId !== 'string' ||
    !value.agentId ||
    value.agentId.length > 256 ||
    typeof value.runId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.runId) ||
    params.agentId !== value.agentId
  )
    throw exactAgentUnavailable()
  return { parentSessionId: value.parentSessionId, agentId: value.agentId, runId: value.runId }
}
/** Discovery may restore its task; exact observations use only its resident client. */
export async function agentConnection(
  runtime: GatewayRuntimeCore,
  params: Record<string, unknown>,
  expected?: BackgroundRunKey,
  capability = 'agentExactRunV1'
) {
  const account = captureAccountContextRevision(), address = record(params.address)
  const id = text(params.taskId) ?? text(address.taskId)
  const before = runtime.tasks.get(runtime.resolveTaskId(id) ?? '')
  const original = before ? { serverId: before.serverId, threadId: before.threadId, workspacePath: before.workspacePath } : undefined
  const requestedTarget = text(address.deviceId) ?? text(params.deviceId) ?? text(params.serverId) ?? before?.serverId
  const requestedConfiguration = runtime.configurationEpochByTarget.get(requestedTarget ?? '')
  const value = await runtime.taskDescriptor(params)
  const { taskId, task, server } = value
  const owner = original ?? { serverId: task.serverId, threadId: task.threadId, workspacePath: task.workspacePath }
  const configuration = requestedTarget ? requestedConfiguration : runtime.configurationEpochByTarget.get(server.id)
  const unavailable = () => expected ? exactAgentUnavailable() : new Error('subagent connection identity changed')
  if (expected && (address.deviceId !== server.id || address.threadId !== expected.parentSessionId ||
      task.threadId !== expected.parentSessionId ||
      text(address.workspacePath) && !sameWorkspacePath(String(address.workspacePath), task.workspacePath)))
    throw exactAgentUnavailable()
  if ([address.deviceId, params.deviceId, params.serverId].map(text).some(target => target && target !== server.id))
    throw expected ? exactAgentUnavailable() : new Error('subagent target identity conflict')
  const assertSource = () => {
    const current = runtime.tasks.get(taskId)
    if (runtime.disposed || !account(server.id) ||
        runtime.configurationEpochByTarget.get(server.id) !== configuration ||
        id && runtime.resolveTaskId(id) !== taskId || server.id !== owner.serverId ||
        current?.threadId !== owner.threadId || current.serverId !== owner.serverId ||
        !sameWorkspacePath(current.workspacePath, owner.workspacePath)) throw unavailable()
  }
  assertSource()
  const client = expected ? runtime.clientByTask.get(taskId) : await runtime.readyTaskClient(task)
  if (!client || expected && client.supportsExperimental?.(capability) !== true) throw exactAgentUnavailable()
  const connection = client.diagnosticConnection?.connectionId
  const assertCurrent = () => {
    assertSource()
    if (runtime.clientByTask.get(taskId) !== client || runtime.appServerDisconnectedClients.has(client) ||
        client.diagnosticConnection?.connectionId !== connection) throw unavailable()
  }
  assertCurrent()
  return { ...value, client, assertCurrent }
}
export function verifyAgentReply(value: unknown, expected: BackgroundRunKey) {
  const result = record(value)
  if (
    result.threadId !== expected.parentSessionId ||
    result.agentId !== expected.agentId ||
    !sameAgentRun(result.backgroundRun, expected)
  )
    throw exactAgentUnavailable()
}
