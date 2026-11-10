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
/** An exact observer uses only an already resident original connection. */
export async function exactAgentConnection(
  runtime: GatewayRuntimeCore,
  params: Record<string, unknown>,
  expected: BackgroundRunKey,
  capability = 'agentExactRunV1'
) {
  const account = captureAccountContextRevision()
  const value = await runtime.taskDescriptor(params)
  const address = record(params.address)
  if (
    address.deviceId !== value.server.id ||
    address.threadId !== expected.parentSessionId ||
    value.task.threadId !== expected.parentSessionId ||
    (text(address.workspacePath) &&
      !sameWorkspacePath(String(address.workspacePath), value.task.workspacePath))
  )
    throw exactAgentUnavailable()
  const client = runtime.clientByTask.get(value.taskId)
  if (!client || client.supportsExperimental?.(capability) !== true)
    throw exactAgentUnavailable()
  const assertCurrent = () => {
    const current = runtime.tasks.get(value.taskId)
    if (
      runtime.disposed ||
      !account(value.server.id) ||
      runtime.clientByTask.get(value.taskId) !== client ||
      current?.threadId !== expected.parentSessionId ||
      current.serverId !== value.server.id ||
      !sameWorkspacePath(current.workspacePath, value.task.workspacePath)
    )
      throw exactAgentUnavailable()
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
